// Runtime configuration, from /etc/asterfi/asterfi.env (loaded by systemd) with dev defaults.
const env = process.env;

export const config = {
  port: Number(env.ASTERFI_PORT || 3000),
  host: env.ASTERFI_HOST || '127.0.0.1',
  databaseUrl: env.DATABASE_URL || 'postgres://asterfi@localhost/asterfi',
  ami: {
    host: env.AMI_HOST || '127.0.0.1',
    port: Number(env.AMI_PORT || 5038),
    username: env.AMI_USER || 'asterfi',
    secret: env.AMI_SECRET || '',
  },
  asteriskConfDir: env.ASTERISK_CONF_DIR || '/etc/asterisk/asterfi',
  voicemailSpool: env.VOICEMAIL_SPOOL || '/var/spool/asterisk/voicemail/asterfi',
  soundsDir: env.ASTERFI_SOUNDS_DIR || '/var/lib/asterisk/sounds/asterfi',
  webDir: env.ASTERFI_WEB_DIR || new URL('../../web/dist', import.meta.url).pathname,
  publicUrl: env.ASTERFI_PUBLIC_URL || '',
  vmContext: 'asterfi',
};
