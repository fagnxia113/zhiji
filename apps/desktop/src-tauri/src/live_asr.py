import argparse
import base64
import json
import os
import queue
import re
import sys
import threading
import traceback
from collections import deque

import numpy as np


ONLINE_MODEL_ID = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online"
QUALITY_MODEL_ID = "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
VAD_MODEL_ID = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
PUNC_MODEL_ID = "iic/punc_ct-transformer_cn-en-common-vocab471067-large"
SPEAKER_MODEL_ID = "iic/speech_campplus_sv_zh-cn_16k-common"
SAMPLE_RATE = 16000
STREAM_CHUNK_SAMPLES = 9600
# 给中文短停顿留出更多余量，避免在“这个方案 / 我觉得”一类自然停顿处过早断句。
ENDPOINT_SAMPLES = int(SAMPLE_RATE * 1.05)
MAX_UTTERANCE_SAMPLES = SAMPLE_RATE * 28
PRE_SPEECH_CHUNKS = 2

_emit_lock = threading.Lock()


def emit(payload):
    with _emit_lock:
        print(json.dumps(payload, ensure_ascii=False), flush=True)


def text_of(result):
    payload = result[0] if isinstance(result, list) and result else result
    if not isinstance(payload, dict):
        return ""
    text = str(payload.get("text") or payload.get("value") or "")
    text = re.sub(r"<\|[^>]*\|>", "", text)
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)
    return re.sub(r"\s+", " ", text).strip()


def find_cached_model(model_cache, preferred_name, model_class):
    preferred = os.path.join(model_cache, preferred_name)
    if os.path.isfile(os.path.join(preferred, "config.yaml")):
        return preferred

    models_root = os.path.join(model_cache, "models")
    if not os.path.isdir(models_root):
        return None
    for root, _, files in os.walk(models_root):
        if "config.yaml" not in files:
            continue
        config_path = os.path.join(root, "config.yaml")
        try:
            with open(config_path, "r", encoding="utf-8") as config:
                if re.search(rf"^model:\s*{re.escape(model_class)}\s*$", config.read(), re.MULTILINE):
                    return root
        except OSError:
            continue
    return None


def prepare_models(model_cache):
    from modelscope import snapshot_download

    online_dir = os.path.join(model_cache, "realtime-online")
    quality_dir = find_cached_model(model_cache, "quality-seaco", "SeacoParaformer")
    os.makedirs(online_dir, exist_ok=True)
    if not os.path.isfile(os.path.join(online_dir, "config.yaml")):
        snapshot_download(
            model_id=ONLINE_MODEL_ID,
            revision="master",
            local_dir=online_dir,
        )
    if quality_dir is None:
        quality_dir = os.path.join(model_cache, "quality-seaco")
        os.makedirs(quality_dir, exist_ok=True)
        snapshot_download(
            model_id=QUALITY_MODEL_ID,
            revision="master",
            local_dir=quality_dir,
        )
    required = [
        ("FsmnVADStreaming", VAD_MODEL_ID, "quality-vad"),
        ("CTTransformer", PUNC_MODEL_ID, "quality-punc"),
        ("CAMPPlus", SPEAKER_MODEL_ID, "quality-speaker"),
    ]
    for model_class, model_id, local_name in required:
        if find_cached_model(model_cache, local_name, model_class) is None:
            local_dir = os.path.join(model_cache, local_name)
            os.makedirs(local_dir, exist_ok=True)
            snapshot_download(model_id=model_id, revision="master", local_dir=local_dir)
    return online_dir, quality_dir


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--hotwords", default="")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    os.environ["MODELSCOPE_CACHE"] = args.model_cache
    os.environ["HF_HOME"] = args.model_cache
    online_dir = os.path.join(args.model_cache, "realtime-online")

    if args.prepare:
        online_dir, quality_dir = prepare_models(args.model_cache)
    else:
        quality_dir = find_cached_model(args.model_cache, "quality-seaco", "SeacoParaformer")

    if not os.path.isfile(os.path.join(online_dir, "config.yaml")):
        raise RuntimeError("本地实时模型不完整，请在设置中点击“检查并修复实时引擎”")

    from funasr import AutoModel

    # 在线模型只负责低延迟初稿。句末精校模型在后台加载，避免阻塞第一句字幕。
    online = AutoModel(
        model=online_dir,
        device="cpu",
        disable_update=True,
        disable_pbar=True,
        log_level="ERROR",
    )
    if args.prepare:
        emit({"type": "prepared", "modelPath": online_dir, "qualityModelPath": quality_dir})
        return

    punc_dir = find_cached_model(args.model_cache, "quality-punc", "CTTransformer")
    quality_state = {"model": None, "error": "", "loading": bool(quality_dir)}
    quality_lock = threading.Lock()
    quality_loaded = threading.Event()

    def load_quality_model():
        if not quality_dir:
            with quality_lock:
                quality_state["loading"] = False
                quality_state["error"] = "高精度句末模型尚未安装"
            emit({
                "type": "quality-unavailable",
                "message": "当前先使用流式字幕；在设置中检查并修复实时引擎后，可启用高精度双遍校正",
            })
            quality_loaded.set()
            return
        emit({"type": "quality-loading"})
        try:
            model_options = {
                "model": quality_dir,
                "device": "cpu",
                "disable_update": True,
                "disable_pbar": True,
                "log_level": "ERROR",
            }
            # 句末二次识别同时补标点。模型缺失时仍可只做高精度识别，不能因此让实时字幕失效。
            if punc_dir:
                model_options["punc_model"] = punc_dir
            model = AutoModel(
                **model_options,
            )
            with quality_lock:
                quality_state["model"] = model
                quality_state["loading"] = False
            quality_loaded.set()
            emit({"type": "quality-ready"})
        except Exception as error:
            with quality_lock:
                quality_state["loading"] = False
                quality_state["error"] = str(error)
            quality_loaded.set()
            emit({
                "type": "quality-unavailable",
                "message": "高精度句末模型未能启动，本场仍保留实时初稿并在会后完整校正",
            })

    emit({"type": "ready"})
    threading.Thread(target=load_quality_model, name="quality-model-loader", daemon=True).start()

    streams = {}
    committed = []
    committed_lock = threading.Lock()
    refine_jobs = queue.Queue()
    session = {"hotwords": args.hotwords.strip()}

    def stream(source):
        if source not in streams:
            streams[source] = {
                "buffer": np.empty(0, dtype="<i2"),
                "cache": {},
                "utterance": [],
                "online_text": "",
                "cursor": 0,
                "utterance_start": 0,
                "silence_samples": 0,
                "utterance_samples": 0,
                "speaking": False,
                "listening": False,
                "noise_floor": 90.0,
                "pre_speech": deque(maxlen=PRE_SPEECH_CHUNKS),
                "utterance_id": "",
            }
        return streams[source]

    def transcript_text():
        with committed_lock:
            items = sorted(committed, key=lambda item: (item["start_ms"], item["sequence"]))
        return "\n".join(
            f"【{'会议声音' if item['source'] == 'system' else '我'}】{item['text']}"
            for item in items
        )

    def voice_state(pcm, state):
        frame_size = 320
        frame_rms = []
        for offset in range(0, pcm.size, frame_size):
            frame = pcm[offset:offset + frame_size]
            if frame.size:
                frame_rms.append(float(np.sqrt(np.mean(frame.astype(np.float64) ** 2))))
        if not frame_rms:
            return False, int(pcm.size), 0.0

        quiet_level = float(np.percentile(frame_rms, 20))
        if not state["speaking"]:
            # 环境突然变吵时慢慢抬高门限，避免把较远的人声立即误当成新的噪声底。
            candidate = min(quiet_level, 420.0)
            smoothing = 0.16 if candidate < state["noise_floor"] else 0.025
            state["noise_floor"] = (
                (1.0 - smoothing) * state["noise_floor"] + smoothing * candidate
            )
        # 开始说话需要更明确的能量；已经进入一句后使用较低门限，保留轻声和句尾。
        threshold_factor = 1.55 if state["speaking"] else 2.15
        threshold_minimum = 58.0 if state["speaking"] else 76.0
        threshold = min(720.0, max(threshold_minimum, state["noise_floor"] * threshold_factor))
        voiced = [index for index, value in enumerate(frame_rms) if value >= threshold]
        active = len(voiced) >= 2 or max(frame_rms) >= threshold * 1.55
        if voiced:
            trailing = max(0, int(pcm.size) - min(int(pcm.size), (voiced[-1] + 1) * frame_size))
        else:
            trailing = int(pcm.size)
        return active, trailing, float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2)))

    def feed_online(source, state, pcm, is_final=False):
        result = online.generate(
            input=pcm.astype(np.float32) / 32768.0,
            cache=state["cache"],
            is_final=is_final,
            chunk_size=[0, 10, 5],
            encoder_chunk_look_back=4,
            decoder_chunk_look_back=1,
        )
        delta = text_of(result)
        if delta:
            state["online_text"] += delta
            emit({
                "type": "partial",
                "source": source,
                "partial": state["online_text"],
                "utteranceId": state["utterance_id"],
                "transcript": transcript_text(),
            })

    def reset_utterance(state):
        state["cache"] = {}
        state["utterance"] = []
        state["online_text"] = ""
        state["silence_samples"] = 0
        state["utterance_samples"] = 0
        state["speaking"] = False
        state["pre_speech"].clear()
        state["utterance_id"] = ""

    def flush_utterance(source):
        state = stream(source)
        if not state["utterance"]:
            reset_utterance(state)
            return
        audio = np.concatenate(state["utterance"]).astype(np.float32) / 32768.0
        job = {
            "source": source,
            "audio": audio,
            "online_text": state["online_text"].strip(),
            "hotwords": session["hotwords"],
            "start_ms": round(state["utterance_start"] * 1000 / SAMPLE_RATE),
            "end_ms": round(state["cursor"] * 1000 / SAMPLE_RATE),
            "utterance_id": state["utterance_id"],
        }
        refine_jobs.put(job)
        emit({"type": "refining", "source": source})
        reset_utterance(state)

    def refine_worker():
        while True:
            job = refine_jobs.get()
            if job is None:
                refine_jobs.task_done()
                return
            final_text = ""
            refined = False
            # 高精度模型在后台加载时先保留音频任务，不急着把低质量初稿定稿。
            quality_loaded.wait(timeout=150)
            with quality_lock:
                quality_model = quality_state["model"]
            if quality_model is not None:
                try:
                    result = quality_model.generate(
                        input=job["audio"],
                        cache={},
                        hotword=job["hotwords"],
                        use_itn=True,
                        batch_size_s=30,
                    )
                    final_text = text_of(result)
                    refined = bool(final_text)
                except Exception as error:
                    emit({"type": "quality-warning", "message": f"本句高精度校正失败，已保留实时初稿：{error}"})
            final_text = final_text or job["online_text"]
            if final_text:
                item = {
                    "source": job["source"],
                    "text": final_text,
                    "start_ms": job["start_ms"],
                    "sequence": len(committed),
                }
                with committed_lock:
                    committed.append(item)
                emit({
                    "type": "final",
                    "source": job["source"],
                    "text": final_text,
                    "transcript": transcript_text(),
                    "startMs": job["start_ms"],
                    "endMs": job["end_ms"],
                    "refined": refined,
                    "utteranceId": job["utterance_id"],
                })
            emit({"type": "refining-done", "utteranceId": job["utterance_id"]})
            refine_jobs.task_done()

    threading.Thread(target=refine_worker, name="sentence-refiner", daemon=True).start()

    def process_chunk(source, pcm, force_final=False):
        state = stream(source)
        active, trailing_silence, rms = voice_state(pcm, state)
        if not state["listening"]:
            state["listening"] = True
            emit({"type": "listening", "source": source})
        emit({"type": "level", "source": source, "level": min(1.0, rms / 4000.0)})

        if not state["speaking"] and not active:
            state["pre_speech"].append(pcm.copy())
            state["cursor"] += int(pcm.size)
            return

        if not state["speaking"]:
            state["speaking"] = True
            prefix = list(state["pre_speech"])
            prefix_samples = sum(chunk.size for chunk in prefix)
            state["utterance_start"] = max(0, state["cursor"] - prefix_samples)
            state["pre_speech"].clear()
            state["utterance_id"] = f"{source}:{state['utterance_start']}"
            for chunk in prefix:
                state["utterance"].append(chunk)
                state["utterance_samples"] += int(chunk.size)
                feed_online(source, state, chunk, is_final=False)

        state["utterance"].append(pcm.copy())
        state["utterance_samples"] += int(pcm.size)
        state["cursor"] += int(pcm.size)
        if active:
            state["silence_samples"] = trailing_silence
        else:
            state["silence_samples"] += int(pcm.size)
        should_finish = (
            force_final
            or state["silence_samples"] >= ENDPOINT_SAMPLES
            or state["utterance_samples"] >= MAX_UTTERANCE_SAMPLES
        )
        feed_online(source, state, pcm, is_final=should_finish)
        if should_finish:
            flush_utterance(source)

    def drain(source, final=False):
        state = stream(source)
        while state["buffer"].size >= STREAM_CHUNK_SAMPLES:
            chunk = state["buffer"][:STREAM_CHUNK_SAMPLES]
            state["buffer"] = state["buffer"][STREAM_CHUNK_SAMPLES:]
            process_chunk(source, chunk, force_final=False)
        if final:
            if state["buffer"].size:
                process_chunk(source, state["buffer"], force_final=True)
                state["buffer"] = np.empty(0, dtype="<i2")
            elif state["speaking"]:
                process_chunk(source, np.zeros(960, dtype="<i2"), force_final=True)

    def run_self_test():
        online.generate(
            input=np.zeros(STREAM_CHUNK_SAMPLES, dtype=np.float32),
            cache={},
            is_final=True,
            chunk_size=[0, 10, 5],
            encoder_chunk_look_back=4,
            decoder_chunk_look_back=1,
        )
        if quality_dir:
            if not quality_loaded.wait(timeout=210):
                raise RuntimeError("高精度句末模型加载超时")
            with quality_lock:
                quality_model = quality_state["model"]
                quality_error = quality_state["error"]
            if quality_model is None:
                raise RuntimeError(f"高精度句末模型不可用：{quality_error}")
            quality_model.generate(
                input=np.zeros(STREAM_CHUNK_SAMPLES, dtype=np.float32),
                cache={},
                hotword=session["hotwords"],
                use_itn=True,
                batch_size_s=30,
            )
        emit({"type": "self-test-passed"})

    if args.self_test:
        run_self_test()
        emit({"type": "finished", "transcript": transcript_text()})
        return

    for line in sys.stdin:
        try:
            message = json.loads(line)
            message_type = message.get("type")
            if message_type == "self-test":
                run_self_test()
                streams.clear()
                with committed_lock:
                    committed.clear()
                continue
            if message_type == "configure":
                session["hotwords"] = str(message.get("hotwords") or "").strip()
                emit({"type": "configured", "hotwordCount": len(session["hotwords"].split())})
                continue
            if message_type == "finish":
                for source in list(streams):
                    drain(source, final=True)
                refine_jobs.join()
                emit({"type": "finished", "transcript": transcript_text()})
                streams.clear()
                with committed_lock:
                    committed.clear()
                continue
            source = "system" if message.get("source") == "system" else "microphone"
            raw = base64.b64decode(message.get("audio", ""))
            pcm = np.frombuffer(raw, dtype="<i2")
            if pcm.size == 0:
                continue
            state = stream(source)
            state["buffer"] = np.concatenate((state["buffer"], pcm))
            drain(source)
        except Exception:
            emit({"type": "warning", "message": traceback.format_exc()[-1800:]})
            raise

    if streams or committed:
        for source in list(streams):
            drain(source, final=True)
        refine_jobs.join()
        emit({"type": "finished", "transcript": transcript_text()})


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        emit({"type": "warning", "message": traceback.format_exc()[-1800:]})
        raise
