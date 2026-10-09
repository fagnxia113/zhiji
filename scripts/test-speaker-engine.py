"""Regression checks for multi-track recognition without downloading any models."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("speaker_engine", ROOT / "apps/desktop/src-tauri/src/speaker_engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class AudioFile:
    samplerate = 16000
    channels = 1
    frames = 32000
    def __init__(self, path):
        self.channels = 2 if path == "stereo" else 1
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False


class SpeakerEngineTests(unittest.TestCase):
    def run_jobs(self, jobs):
        loads, requests, voiceprint_calls = [], [], []

        class Model:
            def __init__(self, **kwargs):
                loads.append(kwargs)
            def generate(self, **kwargs):
                requests.append(kwargs)
                kwargs["cache"]["track"] = kwargs["input"]
                if kwargs["input"] == "bad":
                    raise RuntimeError("bad audio")
                return [{"sentence_info": [
                    {"text": "第一项结论", "start": 500, "end": 1200},
                    {"text": "第二项结论", "start": 1300, "end": 1800},
                ]}]

        def embeddings(model, chunks):
            voiceprint_calls.append(model)
            return None, []

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "jobs.json"
            output = Path(directory) / "result.json"
            source.write_text(json.dumps(jobs), encoding="utf-8")
            argv = ["engine", "--jobs", str(source), "--output", str(output), "--model-cache", directory]
            with patch.dict(sys.modules, {
                "funasr": types.SimpleNamespace(AutoModel=Model),
                "soundfile": types.SimpleNamespace(SoundFile=AudioFile),
            }), patch.object(sys, "argv", argv), \
                patch.object(engine, "find_local_model", side_effect=lambda _, model: model), \
                patch.object(engine, "speaker_chunks", return_value=[]), \
                patch.object(engine, "extract_embeddings", side_effect=embeddings):
                engine.main()
            results = json.loads(output.read_text(encoding="utf-8"))["results"]
        return results, loads, requests, voiceprint_calls

    def test_online_tracks_reuse_recognizer_and_skip_known_microphone_voiceprints(self):
        results, loads, requests, voiceprints = self.run_jobs([
            {"audio": "system", "skipSpeakers": False},
            {"audio": "microphone", "skipSpeakers": True},
        ])
        self.assertEqual([load["model"] for load in loads], ["SeacoParaformer", "CAMPPlus"])
        self.assertEqual(len(voiceprints), 1)
        self.assertIsNot(requests[0]["cache"], requests[1]["cache"])
        for result in results:
            self.assertEqual([segment["text"] for segment in result["segments"]], ["第一项结论", "第二项结论"])
            self.assertEqual([(s["startMs"], s["endMs"]) for s in result["segments"]], [(500, 1200), (1300, 1800)])

    def test_in_room_microphone_still_runs_full_speaker_analysis(self):
        _, loads, _, voiceprints = self.run_jobs([{"audio": "room", "skipSpeakers": False}])
        self.assertEqual(len(voiceprints), 1)
        self.assertEqual(len(loads), 2)

    def test_failed_source_does_not_discard_other_source(self):
        results, loads, _, _ = self.run_jobs([
            {"audio": "bad", "skipSpeakers": False},
            {"audio": "good", "skipSpeakers": True},
        ])
        self.assertEqual(results[0]["error"], "bad audio")
        self.assertEqual(len(results[1]["segments"]), 2)
        self.assertEqual(len(loads), 1)

    def test_stereo_rejected_before_expensive_recognition(self):
        results, _, requests, _ = self.run_jobs([{"audio": "stereo"}])
        self.assertIn("单声道", results[0]["error"])
        self.assertEqual(requests, [])


if __name__ == "__main__":
    unittest.main()
