import argparse
import json
import os
import re
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
        try:
            with open(os.path.join(root, "config.yaml"), "r", encoding="utf-8") as config:
                if re.search(rf"^model:\s*{re.escape(model_class)}\s*$", config.read(), re.MULTILINE):
                    return root
        except OSError:
            continue
    return None


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


def cluster_embeddings(embeddings):
    import numpy as np
    from funasr.models.campplus.cluster_backend import ClusterBackend

    if embeddings.shape[0] == 1:
        return np.zeros(1, dtype="int")
    # FunASR deliberately collapses fewer than 20 windows to one speaker. Meetings
    # often contain fewer windows, so use cosine hierarchical clustering there.
    if embeddings.shape[0] < 20:
        from sklearn.cluster import AgglomerativeClustering

        values = embeddings.numpy()
        try:
            cluster = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=0.32,
                metric="cosine",
                linkage="average",
            )
        except TypeError:
            cluster = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=0.32,
                affinity="cosine",
                linkage="average",
            )
        return cluster.fit_predict(values)
    # Spectral clustering scales poorly with the square of meeting length. For a
    # long meeting, cluster an evenly sampled overview and map all windows to its
    # speaker centroids by cosine similarity.
    sample_limit = 600
    if embeddings.shape[0] <= sample_limit:
        return ClusterBackend()(embeddings).astype("int")
    import torch
    import torch.nn.functional as functional

    indexes = torch.linspace(0, embeddings.shape[0] - 1, sample_limit).long()
    sample = embeddings[indexes]
    sample_labels = ClusterBackend()(sample).astype("int")
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--hotwords", default="")
    args = parser.parse_args()

    os.environ["MODELSCOPE_CACHE"] = args.model_cache
    os.environ["HF_HOME"] = args.model_cache
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from funasr import AutoModel
    import soundfile as sf

    asr_model = find_local_model(args.model_cache, "SeacoParaformer")
    vad_model = find_local_model(args.model_cache, "FsmnVADStreaming")
    punc_model = find_local_model(args.model_cache, "CTTransformer")
    spk_model = find_local_model(args.model_cache, "CAMPPlus")
    if not all((asr_model, vad_model, punc_model, spk_model)):
        raise RuntimeError("高精度会议模型不完整，请在设置中点击“检查并修复实时引擎”")

    # First pass: speech recognition and sentence timestamps. Keeping the speaker
    # model out of this pass avoids a FunASR index mismatch on silent VAD segments.
    recognizer = AutoModel(
        model=asr_model,
        vad_model=vad_model,
        punc_model=punc_model,
        vad_kwargs={"max_single_segment_time": 30000},
        device="cpu",
        disable_update=True,
        disable_pbar=True,
        log_level="ERROR",
    )
    result = recognizer.generate(
        input=args.audio,
        cache={},
        hotword=args.hotwords,
        use_itn=True,
        batch_size_s=60,
        merge_vad=True,
        merge_length_s=15,
        sentence_timestamp=True,
    )
    payload = result[0] if isinstance(result, list) else result
    with sf.SoundFile(args.audio) as audio_file:
        sample_rate = audio_file.samplerate
        if sample_rate != 16000:
            raise RuntimeError("说话人分析需要 16kHz 单声道录音")
        sentences = normalize_sentence_info(payload, audio_file.frames)
        if not sentences:
            raise RuntimeError("会议引擎没有返回可用的转写分段")

        # Second pass: voiceprints and clustering. This pass is independent from
        # ASR, so an empty recognition segment cannot make result arrays diverge.
        speaker_model = AutoModel(
            model=spk_model,
            device="cpu",
            disable_update=True,
            disable_pbar=True,
            log_level="ERROR",
        )
        embeddings, owners = extract_embeddings(
            speaker_model, speaker_chunks(sentences, audio_file, sample_rate)
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
    with open(args.output, "w", encoding="utf-8") as output:
        json.dump({"transcript": transcript, "segments": segments}, output, ensure_ascii=False)


if __name__ == "__main__":
    main()
