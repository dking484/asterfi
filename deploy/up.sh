#!/bin/bash
# usage: up.sh <local> <remote>   (recursive copy as the deploy user)
. "$(dirname "$0")/local.env"
pscp -batch -hostkey "$ASTERFI_HOSTKEY" -pw "$ASTERFI_PW" -r -q "$1" "$ASTERFI_SSH:$2"
