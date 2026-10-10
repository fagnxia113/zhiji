"""Real clustering/cache checks; run with the installed local meeting Python."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

try:
    import numpy as np
    import torch
    import soundfile as sf
    import funasr
    READY = True
    torch.set_num_threads(4)
except ImportError:
    READY = False

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("speaker_engine", ROOT / "apps/desktop/src-tauri/src/speaker_engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


@unittest.skipUnless(READY, "Requires installed meeting engine dependencies; no model download")
class ClusteringTests(unittest.TestCase):
    def vectors(self, owners):
        return torch.eye(8)[owners]

    def test_explicit_count_preserves_three_distinct_voices_on_short_and_long_audio(self):
        for owners in ([0, 1, 2] * 3, [0, 1, 2] * 701):
            labels = engine.cluster_embeddings(self.vectors(owners), 3)
            self.assertEqual(len(set(labels)), 3)
            groups = [set(labels[np.asarray(owners) == owner]) for owner in range(3)]
            self.assertTrue(all(len(group) == 1 for group in groups))
            self.assertTrue(groups[0].isdisjoint(groups[1]) and groups[1].isdisjoint(groups[2]))

    def test_auto_does_not_invent_multiple_roles_for_identical_short_voiceprints(self):
        self.assertEqual(len(set(engine.cluster_embeddings(self.vectors([0] * 9)))), 1)

    def setup_audio(self, directory):
        audio = Path(directory) / "audio.wav"
        sf.write(audio, np.zeros(16000 * 4), 16000)
        segments = [{"startMs": i * 1000, "endMs": i * 1000 + 900, "text": "保留校对文字"} for i in range(3)]
        return str(audio), segments, str(Path(directory) / "cache" / "voices.npz")

    def extract(self):
        return patch.object(engine, "extract_embeddings", return_value=(self.vectors([0, 1, 2]), [0, 1, 2]))

    def test_count_change_reuses_features_without_audio_read_or_model_load(self):
        with tempfile.TemporaryDirectory() as directory:
            audio, segments, cache = self.setup_audio(directory)
            with self.extract() as extraction:
                result = engine.rediarize_audio(audio, segments, lambda: object(), 3, cache)
                self.assertEqual(result, {"speakerIds": [0, 1, 2]})
                self.assertEqual(extraction.call_count, 1)
            with patch.object(sf, "SoundFile", side_effect=AssertionError("Do not reread audio")):
                result = engine.rediarize_audio(audio, segments, lambda: self.fail("Do not reload model"), 2, cache)
            self.assertEqual(len(set(result["speakerIds"])), 2)
            with np.load(cache, allow_pickle=False) as data:
                self.assertEqual(set(data.files), {"embeddings", "owners", "starts", "ends"})

    def test_changed_timestamps_and_corrupt_cache_reextract(self):
        with tempfile.TemporaryDirectory() as directory:
            audio, segments, cache = self.setup_audio(directory)
            with self.extract():
                engine.rediarize_audio(audio, segments, lambda: object(), 3, cache)
            segments[0]["endMs"] = 800
            with self.extract() as extraction:
                engine.rediarize_audio(audio, segments, lambda: object(), 3, cache)
                self.assertEqual(extraction.call_count, 1)
            Path(cache).write_bytes(b"corrupt cache")
            with self.extract() as extraction:
                engine.rediarize_audio(audio, segments, lambda: object(), 3, cache)
                self.assertEqual(extraction.call_count, 1)

    def test_optional_cache_write_failure_keeps_valid_role_result(self):
        with tempfile.TemporaryDirectory() as directory:
            audio, segments, cache = self.setup_audio(directory)
            with self.extract(), patch.object(engine.os, "makedirs", side_effect=PermissionError("read only")):
                self.assertEqual(engine.rediarize_audio(audio, segments, lambda: object(), 3, cache)["speakerIds"], [0, 1, 2])

    def test_missing_features_or_unrepresented_requested_role_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            audio, segments, _ = self.setup_audio(directory)
            with patch.object(engine, "extract_embeddings", return_value=(None, [])), self.assertRaisesRegex(RuntimeError, "可用声纹"):
                engine.rediarize_audio(audio, segments, lambda: object(), 3)
            with patch.object(engine, "extract_embeddings", return_value=(self.vectors([0, 1, 2]), [0, 0, 1])), self.assertRaisesRegex(RuntimeError, "未达到指定"):
                engine.rediarize_audio(audio, segments, lambda: object(), 3)


if __name__ == "__main__":
    unittest.main()
