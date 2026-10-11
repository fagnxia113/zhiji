import argparse
import json
import os
import re
import sys
import time
from collections import Counter


def value(item, *keys):
    for key in keys:
        candidate = item.get(key)
        if candidate not in (None, ""):
            return candidate
    return ""


def clean_text(text):
    text = re.sub(r"<\|[^>]*\|>", "", str(text))
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)
    return re.sub(r"\s+", " ", text).strip()


def find_local_model(model_cache, model_class):
    if not os.path.isdir(model_cache):
        return None
    for root, _, files in os.walk(model_cache):
        if "config.yaml" not in files:
            continue
        if any(name.endswith((".incomplete", ".part")) for name in files) or not any(name in files for name in ("model.pt", "campplus_cn_common.bin")):
            continue
        try:
            with open(os.path.join(root, "config.yaml"), "r", encoding="utf-8") as config:
                if re.search(rf"^model:\s*{re.escape(model_class)}\s*$", config.read(), re.MULTILINE):
                    return root
        except OSError:
            continue
    return None


def prepare_models(model_cache):
    """Reuse complete models; prepare only the four post-meeting models."""
    from modelscope import snapshot_download
    required = [
        ("SeacoParaformer", "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch", "quality-seaco"),
        ("FsmnVADStreaming", "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", "quality-vad"),
        ("CTTransformer", "iic/punc_ct-transformer_cn-en-common-vocab471067-large", "quality-punc"),
        ("CAMPPlus", "iic/speech_campplus_sv_zh-cn_16k-common", "quality-speaker"),
    ]
    for model_class, model_id, local_name in required:
        if find_local_model(model_cache, model_class) is None:
            directory = os.path.join(model_cache, local_name)
            os.makedirs(directory, exist_ok=True)
            snapshot_download(model_id=model_id, revision="master", local_dir=directory)
            if find_local_model(model_cache, model_class) is None:
                raise RuntimeError(f"{model_class} 模型下载不完整，请重试")


def normalize_sentence_info(payload, audio_sample_count):
    sentences = []
    for item in payload.get("sentence_info", []):
        text = clean_text(value(item, "text", "sentence"))
        if not text:
            continue
        start = max(0, int(value(item, "start") or 0))
        end = max(start, int(value(item, "end") or start))
        sentences.append({"text": text, "start": start, "end": end})
    if sentences:
        return sentences
    text = clean_text(payload.get("text") or payload.get("value") or "")
    if not text:
        return []
    return [{"text": text, "start": 0, "end": int(audio_sample_count / 16)}]


def speaker_chunks(sentences, audio_file, sample_rate=16000):
    """Yield voiceprint windows without loading a multi-hour meeting into memory."""
    import numpy as np

    chunk_samples = int(1.5 * sample_rate)
    shift_samples = int(0.75 * sample_rate)
    for owner, sentence in enumerate(sentences):
        start_sample = min(audio_file.frames, int(sentence["start"] * sample_rate / 1000))
        end_sample = min(audio_file.frames, int(sentence["end"] * sample_rate / 1000))
        if end_sample <= start_sample:
            continue
        audio_file.seek(start_sample)
        data = audio_file.read(end_sample - start_sample, dtype="float32", always_2d=False)
        if getattr(data, "ndim", 1) > 1:
            data = data.mean(axis=1)
        last_end = 0
        for offset in range(0, len(data), shift_samples):
            chunk_end = min(offset + chunk_samples, len(data))
            if chunk_end <= last_end:
                break
            last_end = chunk_end
            chunk_start = max(0, chunk_end - chunk_samples)
            chunk = data[chunk_start:chunk_end]
            if len(chunk) < chunk_samples:
                chunk = np.pad(chunk, (0, chunk_samples - len(chunk)), "constant")
            yield chunk, owner


def extract_embeddings(model, chunk_stream):
    import torch

    embeddings = []
    owners = []
    batch = []
    batch_owners = []

    def run_batch():
        if not batch:
            return
        results = model.generate(input=batch, batch_size=len(batch))
        batch_embeddings = [result.get("spk_embedding") for result in results]
        batch_embeddings = [item.detach().cpu() for item in batch_embeddings if item is not None]
        if not batch_embeddings:
            raise RuntimeError("说话人模型没有返回有效声纹")
        merged_batch = torch.cat(batch_embeddings, dim=0)
        if merged_batch.shape[0] != len(batch):
            raise RuntimeError("说话人声纹数量与音频分段不一致")
        embeddings.append(merged_batch)
        owners.extend(batch_owners)

    # A bounded batch avoids both excessive memory use on long meetings and the
    # FunASR result-count mismatch that occurs in its combined ASR+SPK pipeline.
    for chunk, owner in chunk_stream:
        batch.append(chunk)
        batch_owners.append(owner)
        if len(batch) == 24:
            run_batch()
            batch.clear()
            batch_owners.clear()
    run_batch()
    if not embeddings:
        return None, []
    merged = torch.cat(embeddings, dim=0)
    return merged, owners


def cluster_embeddings(embeddings, speaker_count=None):
    import numpy as np
    from funasr.models.campplus.cluster_backend import ClusterBackend

    if speaker_count is not None and not 1 <= speaker_count <= min(15, embeddings.shape[0]):
        raise RuntimeError("发言人数需为 1–15，且不能超过有效声音片段数量")
    if embeddings.shape[0] == 1 or speaker_count == 1:
        return np.zeros(embeddings.shape[0], dtype="int")
    # FunASR deliberately collapses fewer than 20 windows to one speaker. Meetings
    # often contain fewer windows, so use cosine hierarchical clustering there.
    if embeddings.shape[0] < 20:
        from sklearn.cluster import AgglomerativeClustering

        values = embeddings.numpy()
        options = ({"n_clusters": speaker_count} if speaker_count is not None else
                   {"n_clusters": None, "distance_threshold": 0.32})
        try:
            cluster = AgglomerativeClustering(
                **options,
                metric="cosine",
                linkage="average",
            )
        except TypeError:
            cluster = AgglomerativeClustering(
                **options,
                affinity="cosine",
                linkage="average",
            )
        return cluster.fit_predict(values)
    # Spectral clustering scales poorly with the square of meeting length. For a
    # long meeting, cluster an evenly sampled overview and map all windows to its
    # speaker centroids by cosine similarity.
    # 采样数必须保持在谱聚类能保留声纹结构的规模：远场会议的声纹区分度本就
    # 偏低（同人窗间余弦仅 0.4~0.5），抽稀到 600 个样本会让谱聚类的本征间隙
    # 判定失效、全场塌缩成一个人（2026-09-10 现场会议 2945 窗塌缩成 1 簇的
    # 实测）。2000 个采样既能控制耗时（eigh 2000x2000 约数秒），又验证可
    # 分出与全量谱聚类 96%+ 一致的多说话人。
    sample_limit = 2000
    params = {"oracle_num": speaker_count} if speaker_count is not None else {}
    if embeddings.shape[0] <= sample_limit:
        return ClusterBackend()(embeddings, **params).astype("int")
    import torch
    import torch.nn.functional as functional

    indexes = torch.linspace(0, embeddings.shape[0] - 1, sample_limit).long()
    sample = embeddings[indexes]
    sample_labels = ClusterBackend()(sample, **params).astype("int")
    centers = torch.stack(
        [sample[torch.from_numpy(sample_labels == label)].mean(0) for label in sorted(set(sample_labels))]
    )
    similarities = functional.normalize(embeddings, dim=1) @ functional.normalize(centers, dim=1).T
    return similarities.argmax(dim=1).numpy().astype("int")


def assign_speakers(sentences, owners, labels):
    labels_by_sentence = [[] for _ in sentences]
    for owner, label in zip(owners, labels):
        labels_by_sentence[owner].append(int(label))
    previous = 0
    for index, sentence_labels in enumerate(labels_by_sentence):
        if sentence_labels:
            previous = Counter(sentence_labels).most_common(1)[0][0]
        sentences[index]["spk"] = previous


def rediarize_audio(audio_path, segments, get_speaker_model, speaker_count=None, embedding_cache=None):
    """Use saved timestamps to change roles without running speech recognition."""
    import numpy as np
    import soundfile as sf
    import torch
    from zipfile import BadZipFile

    if not segments:
        raise RuntimeError("请先生成带时间的原文，再重新区分角色")
    sentences = [{"start": int(s["startMs"]), "end": int(s["endMs"])} for s in segments]
    if any(s["start"] < 0 or s["end"] <= s["start"] for s in sentences):
        raise RuntimeError("原文时间标记不完整，请先重新生成完整原文")
    starts = np.asarray([s["start"] for s in sentences])
    ends = np.asarray([s["end"] for s in sentences])
    embeddings, owners = None, []
    if embedding_cache:
        try:
            if time.time() - os.path.getmtime(embedding_cache) >= 1800:
                raise ValueError("expired cache")
            with np.load(embedding_cache, allow_pickle=False) as cached:
                if np.array_equal(cached["starts"], starts) and np.array_equal(cached["ends"], ends):
                    values, cached_owners = cached["embeddings"], cached["owners"]
                    if values.ndim == 2 and values.shape[1] > 0 and cached_owners.ndim == 1 and np.issubdtype(cached_owners.dtype, np.integer) and len(values) == len(cached_owners) and len(values) > 0 and np.isfinite(values).all() and cached_owners.min() >= 0 and cached_owners.max() < len(sentences):
                        embeddings, owners = torch.from_numpy(values), cached_owners.tolist()
        except (OSError, ValueError, KeyError, EOFError, BadZipFile):
            pass
    if embeddings is None:
        with sf.SoundFile(audio_path) as audio_file:
            if audio_file.samplerate != 16000 or audio_file.channels != 1:
                raise RuntimeError("说话人分析需要 16kHz 单声道录音")
            if max(ends) > audio_file.frames / 16 + 1000:
                raise RuntimeError("原文时间超出录音长度，无法安全重新区分角色")
            embeddings, owners = extract_embeddings(get_speaker_model(), speaker_chunks(sentences, audio_file))
        if embeddings is None:
            raise RuntimeError("录音没有返回可用声纹，原文和现有角色已保留")
        if embedding_cache:
            # The cache contains features and timestamps, never transcript text.
            import tempfile
            cache_dir = os.path.dirname(embedding_cache)
            temp_path = None
            try:
                os.makedirs(cache_dir, exist_ok=True)
                entries = sorted((os.path.join(cache_dir, name) for name in os.listdir(cache_dir) if name.endswith(".npz")), key=os.path.getmtime)
                excess = max(0, len(entries) - 7)
                for index, old in enumerate(entries):
                    if index < excess or time.time() - os.path.getmtime(old) >= 1800:
                        try:
                            os.remove(old)
                        except OSError:
                            pass
                with tempfile.NamedTemporaryFile(dir=cache_dir, suffix=".tmp", delete=False) as temp:
                    temp_path = temp.name
                    np.savez(temp, embeddings=embeddings.numpy(), owners=np.asarray(owners), starts=starts, ends=ends)
                os.replace(temp_path, embedding_cache)
            except OSError:
                pass  # Caching is optional; disk/permission failures must not discard roles.
            finally:
                if temp_path and os.path.isfile(temp_path):
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass
    labels = cluster_embeddings(embeddings, speaker_count)
    assign_speakers(sentences, owners, labels)
    mapping = {}
    ids = [mapping.setdefault(s["spk"], len(mapping)) for s in sentences]
    if speaker_count is not None and len(mapping) != speaker_count:
        raise RuntimeError(f"只能稳定分出 {len(mapping)} 个角色，未达到指定的 {speaker_count} 人；请调整人数或核对录音")
    return {"speakerIds": ids}


def recognize_audio(audio_path, hotwords, recognizer, get_speaker_model, skip_speakers=False):
    import soundfile as sf

    started = time.monotonic()
    with sf.SoundFile(audio_path) as audio_file:
        sample_rate = audio_file.samplerate
        if sample_rate != 16000 or audio_file.channels != 1:
            raise RuntimeError("说话人分析需要 16kHz 单声道录音")
        result = recognizer.generate(
            input=audio_path, cache={}, hotword=hotwords, use_itn=True,
            batch_size_s=60, merge_vad=True, merge_length_s=15,
            sentence_timestamp=True,
        )
        payload = result[0] if isinstance(result, list) else result
        sentences = normalize_sentence_info(payload, audio_file.frames)
        if not sentences:
            raise RuntimeError("会议引擎没有返回可用的转写分段")
        print(f"ASR finished in {time.monotonic() - started:.1f}s", file=sys.stderr)
        # An online microphone track already has a known owner. Keep recognition
        # and timestamps identical while avoiding all voiceprint work on it.
        embeddings, owners = None, []
        if not skip_speakers:
            embeddings, owners = extract_embeddings(
                get_speaker_model(), speaker_chunks(sentences, audio_file, sample_rate)
            )
    if embeddings is not None:
        labels = cluster_embeddings(embeddings)
        assign_speakers(sentences, owners, labels)
    else:
        for sentence in sentences:
            sentence["spk"] = 0

    # Normalize arbitrary cluster numbers by first appearance for stable labels.
    speaker_ids = {}
    segments = []
    for item in sentences:
        raw_speaker = int(item.get("spk", 0))
        speaker = speaker_ids.setdefault(raw_speaker, len(speaker_ids))
        segments.append(
            {
                "speaker": f"发言人 {speaker + 1}",
                "speakerId": speaker,
                "startMs": int(item["start"]),
                "endMs": int(item["end"]),
                "text": item["text"],
            }
        )
    transcript = "\n".join(f"【{item['speaker']}】{item['text']}" for item in segments)
    print(f"Track finished in {time.monotonic() - started:.1f}s", file=sys.stderr)
    return {"transcript": transcript, "segments": segments}


def main():
    parser = argparse.ArgumentParser()
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--audio")
    inputs.add_argument("--jobs", help="JSON list of audio/skipSpeakers jobs")
    parser.add_argument("--output")
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--hotwords", default="")
    parser.add_argument("--skip-speakers", action="store_true")
    parser.add_argument("--segments", help="Saved timestamps for speaker-only correction")
    parser.add_argument("--speaker-count", type=int)
    parser.add_argument("--embedding-cache")
    parser.add_argument("--prepare", action="store_true", help="Prepare post-meeting models, without recognition")
    args = parser.parse_args()
    os.environ["MODELSCOPE_CACHE"] = args.model_cache
    os.environ["HF_HOME"] = args.model_cache
    if args.prepare:
        if args.audio or args.jobs or args.segments or args.speaker_count is not None or args.embedding_cache:
            parser.error("--prepare 不接受录音或角色修正参数")
        prepare_models(args.model_cache)
        return
    if not (args.audio or args.jobs) or not args.output:
        parser.error("需提供 --audio 或 --jobs，以及 --output")
    if not args.segments and (args.speaker_count is not None or args.embedding_cache):
        parser.error("--speaker-count 和 --embedding-cache 仅用于 --segments 角色修正")

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from funasr import AutoModel

    speaker_model = None

    def get_speaker_model():
        nonlocal speaker_model
        if speaker_model is None:
            model_path = find_local_model(args.model_cache, "CAMPPlus")
            if not model_path:
                raise RuntimeError("说话人模型不完整，请在设置中修复会议引擎")
            speaker_model = AutoModel(
                model=model_path, device="cpu", disable_update=True,
                disable_pbar=True, log_level="ERROR",
            )
        return speaker_model

    if args.segments:
        if not args.audio or args.jobs:
            raise RuntimeError("重新区分角色需提供一份录音及原文时间标记")
        with open(args.segments, encoding="utf-8") as source:
            segments = json.load(source)
        result = rediarize_audio(args.audio, segments, get_speaker_model, args.speaker_count, args.embedding_cache)
        with open(args.output, "w", encoding="utf-8") as output:
            json.dump(result, output, ensure_ascii=False)
        return

    asr_model = find_local_model(args.model_cache, "SeacoParaformer")
    vad_model = find_local_model(args.model_cache, "FsmnVADStreaming")
    punc_model = find_local_model(args.model_cache, "CTTransformer")
    if not all((asr_model, vad_model, punc_model)):
        raise RuntimeError("高精度会议模型不完整，请在设置中点击“检查并修复会议引擎”")
    recognizer = AutoModel(
        model=asr_model, vad_model=vad_model, punc_model=punc_model,
        vad_kwargs={"max_single_segment_time": 30000}, device="cpu",
        disable_update=True, disable_pbar=True, log_level="ERROR",
    )

    if args.jobs:
        with open(args.jobs, encoding="utf-8") as source:
            jobs = json.load(source)
        results = []
        for job in jobs:
            try:
                results.append(recognize_audio(
                    job["audio"], args.hotwords, recognizer, get_speaker_model,
                    bool(job.get("skipSpeakers", False)),
                ))
            except Exception as error:
                # A bad/empty source must not discard the other track's transcript.
                results.append({"error": str(error)})
        result = {"results": results}
    else:
        result = recognize_audio(args.audio, args.hotwords, recognizer, get_speaker_model, args.skip_speakers)
    with open(args.output, "w", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False)


if __name__ == "__main__":
    main()
