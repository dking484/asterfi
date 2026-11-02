#!/opt/asterfi/tts/venv/bin/python
"""Render text to a WAV file with Kokoro (ONNX, CPU). Called by the AsterFi service.

usage: kokoro_tts.py --out FILE [--voice af_heart] [--speed 1.0] < text
       kokoro_tts.py --list
"""
import argparse, os, sys

MODELS = os.environ.get('KOKORO_MODELS', '/opt/asterfi/tts/models')
MODEL = os.path.join(MODELS, 'kokoro-v1.0.int8.onnx')
VOICES = os.path.join(MODELS, 'voices-v1.0.bin')

ap = argparse.ArgumentParser()
ap.add_argument('--out')
ap.add_argument('--voice', default='af_heart')
ap.add_argument('--speed', type=float, default=1.0)
ap.add_argument('--list', action='store_true')
args = ap.parse_args()

from kokoro_onnx import Kokoro  # noqa: E402  (slow import; keep --help fast)
import soundfile as sf  # noqa: E402

kokoro = Kokoro(MODEL, VOICES)
if args.list:
    print('\n'.join(sorted(kokoro.get_voices())))
    sys.exit(0)

text = sys.stdin.read().strip()
if not text or not args.out:
    sys.exit('text on stdin and --out are required')
voice = args.voice if args.voice in kokoro.get_voices() else 'af_heart'
# Voice ids start with a language letter: a=US English, b=UK English, e=Spanish, f=French, ...
lang = {'a': 'en-us', 'b': 'en-gb', 'e': 'es', 'f': 'fr-fr', 'i': 'it', 'p': 'pt-br', 'h': 'hi', 'j': 'ja', 'z': 'cmn'}.get(voice[:1], 'en-us')
samples, rate = kokoro.create(text, voice=voice, speed=max(0.5, min(2.0, args.speed)), lang=lang)
sf.write(args.out, samples, rate)
