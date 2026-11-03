// Internal event bus. Everything that can become a webhook goes through publish().
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export const EVENT_TYPES = [
  { name: 'call.inbound', description: 'An outside call arrived on one of your numbers' },
  { name: 'call.outbound', description: 'A user placed a call to an outside number' },
  { name: 'call.ringing', description: "A user's phone started ringing" },
  { name: 'call.answered', description: 'A call was answered' },
  { name: 'call.ended', description: 'A call finished (includes the full call record)' },
  { name: 'call.queued', description: 'A caller started waiting in a ring group queue' },
  { name: 'call.callback', description: 'A waiting caller asked a ring group to call them back' },
  { name: 'call.missed', description: 'A user missed a call (sent per user)' },
  { name: 'voicemail.new', description: 'A new voicemail was left' },
  { name: 'voicemail.transcribed', description: "A voicemail's transcript is ready (or transcription failed)" },
  { name: 'ivr.keypress', description: 'A caller made a choice in a call flow, or passed a Notify block' },
  { name: 'phone.registered', description: 'A phone came online' },
  { name: 'phone.unregistered', description: 'A phone went offline' },
  { name: 'user.dnd', description: 'A user turned Do Not Disturb on or off' },
  { name: 'trunk.registration', description: 'A SIP trunk registered, or was rejected by the provider' },
];

export function publish(event, data) {
  bus.emit('event', { event, timestamp: new Date().toISOString(), data });
}
