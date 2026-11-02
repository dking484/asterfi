#!/usr/bin/env python3
"""Remove every registration binding an account has at a SIP registrar (REGISTER Contact: *, Expires: 0).

Used to clear stale registrations a carrier kept from earlier Asterisk restarts.
usage: sip-clear-bindings.py <host> <port> <username> <password> [auth_username] [public_ip] [contact ...]
With contacts given, only those bindings are removed (for registrars that ignore Contact: *).
"""
import hashlib, os, random, re, socket, sys

host, port, user, password = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
auth_user = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else user
public_ip = sys.argv[6] if len(sys.argv) > 6 else '0.0.0.0'
contacts = sys.argv[7:]

md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(('0.0.0.0', 0))
sock.settimeout(5)
lport = sock.getsockname()[1]
call_id = f'{random.getrandbits(64):x}@asterfi'
tag = f'{random.getrandbits(32):x}'
uri = f'sip:{host}:{port}'


def send(cseq, auth=None):
    branch = f'z9hG4bK{random.getrandbits(48):x}'
    lines = [
        f'REGISTER {uri} SIP/2.0',
        f'Via: SIP/2.0/UDP {public_ip}:{lport};rport;branch={branch}',
        'Max-Forwards: 70',
        f'From: <sip:{user}@{host}>;tag={tag}',
        f'To: <sip:{user}@{host}>',
        f'Call-ID: {call_id}',
        f'CSeq: {cseq} REGISTER',
        *([f'Contact: <{c}>;expires=0' for c in contacts] or ['Contact: *']),
        'Expires: 0',
        'User-Agent: AsterFi PBX',
    ]
    if auth:
        lines.append(auth)
    lines += ['Content-Length: 0', '', '']
    sock.sendto('\r\n'.join(lines).encode(), (host, port))
    while True:
        data = sock.recv(65535).decode(errors='replace')
        status = int(data.split(' ', 2)[1])
        if status >= 200:
            return status, data


status, resp = send(1)
if status in (401, 407):
    hdr = 'WWW-Authenticate' if status == 401 else 'Proxy-Authenticate'
    m = re.search(rf'^{hdr}:\s*Digest (.+)$', resp, re.M | re.I)
    params = dict(re.findall(r'(\w+)="?([^",]+)"?', m.group(1)))
    realm, nonce = params['realm'], params['nonce']
    ha1 = md5(f'{auth_user}:{realm}:{password}')
    ha2 = md5(f'REGISTER:{uri}')
    cnonce, nc = os.urandom(8).hex(), '00000001'
    if 'auth' in params.get('qop', ''):
        response = md5(f'{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}')
        extra = f', qop=auth, nc={nc}, cnonce="{cnonce}"'
    else:
        response = md5(f'{ha1}:{nonce}:{ha2}')
        extra = ''
    auth = (f'{"Authorization" if status == 401 else "Proxy-Authorization"}: Digest username="{auth_user}", '
            f'realm="{realm}", nonce="{nonce}", uri="{uri}", response="{response}", algorithm=MD5{extra}')
    status, resp = send(2, auth)
print(resp.split('\r\n', 1)[0])
sys.exit(0 if status == 200 else 1)
