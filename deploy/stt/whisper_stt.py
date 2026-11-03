#!/opt/asterfi/stt/venv/bin/python
"""Transcribe a voicemail with faster-whisper (CPU, int8). Called by the AsterFi service.

usage: whisper_stt.py [--model base.en] [--revision HASH] FILE.wav   prints the transcript on stdout
       whisper_stt.py --download MODEL [--revision HASH]             fetches a model into the models folder

--revision pins the model to a Hugging Face commit (AsterFi's compatibility.json lists the tested ones).
"""
import argparse, os, sys

MODELS = os.environ.get('WHISPER_MODELS', '/opt/asterfi/stt/models')

ap = argparse.ArgumentParser()
ap.add_argument('file', nargs='?')
ap.add_argument('--model', default='base.en')
ap.add_argument('--download', metavar='MODEL')
ap.add_argument('--revision', default=None)
args = ap.parse_args()

import numpy as np  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402  (slow import; keep --help fast)

if args.download:
    WhisperModel(args.download, device='cpu', compute_type='int8', download_root=MODELS, revision=args.revision)
    sys.exit(0)
if not args.file:
    sys.exit('a WAV file is required')


def load_audio(path):
    """16 kHz mono float32 samples. Decoded here rather than by faster-whisper, whose PyAV decoder breaks
    with newer PyAV releases. ffmpeg handles any format; the fallback reads plain PCM WAV (Asterisk's .wav)."""
    import shutil, subprocess
    if shutil.which('ffmpeg'):
        raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
                             check=True, capture_output=True).stdout
        return np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    import wave
    with wave.open(path) as w:
        if w.getsampwidth() != 2:
            sys.exit('only 16-bit PCM WAV can be read without ffmpeg')
        pcm = np.frombuffer(w.readframes(w.getnframes()), np.int16).reshape(-1, w.getnchannels()).mean(axis=1)
        rate = w.getframerate()
    t = np.arange(0, len(pcm) / rate, 1 / 16000)
    return (np.interp(t, np.arange(len(pcm)) / rate, pcm) / 32768).astype(np.float32)


# Phone audio is 8 kHz, upsampled to the 16 kHz Whisper expects. The VAD filter skips silence and hold-music tails.
# Models are downloaded at install time (setup.sh); the service never fetches anything.
model = WhisperModel(args.model, device='cpu', compute_type='int8', download_root=MODELS, local_files_only=True, revision=args.revision,
                     cpu_threads=max(1, (os.cpu_count() or 2) - 1))
segments, _ = model.transcribe(load_audio(args.file), language='en' if args.model.endswith('.en') else None,
                               beam_size=5, vad_filter=True, condition_on_previous_text=False)
print(' '.join(s.text.strip() for s in segments).strip())
