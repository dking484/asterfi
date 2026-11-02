#!/bin/bash
# usage: r.sh 'cmd'          -> run as the deploy user
#        r.sh -s script.sh   -> run script as root
. "$(dirname "$0")/local.env"
H="-batch -hostkey $ASTERFI_HOSTKEY -ssh $ASTERFI_SSH -pw $ASTERFI_PW"
if [ "$1" = "-s" ]; then
  (echo "$ASTERFI_PW"; cat "$2") | plink $H 'sudo -S -p "" bash -s'
else
  plink $H "$1"
fi
