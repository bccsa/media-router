#!/bin/sh
# record-bus.sh <box> <socket> <seconds> <name> [record-bus.py options]: a bus recording made on
# a box (plan ch. 7 WI-P3-3; DEV rounds): copies record-bus.py there (mrscp), runs it as the user
# unit p3rec-<name> (systemd-run --user, so it outlives this ssh session), waits for it, then
# copies <name>.ts, <name>.bus.jsonl (and <name>.pads.jsonl with --demux) and its log back into
# the current directory and removes them on the box. <socket> is an edge socket the box serves.
set -eu
[ $# -ge 4 ] || { echo "usage: record-bus.sh box socket seconds name [--demux MODE] [--plugin SO]" >&2; exit 2; }
box=$1 sock=$2 secs=$3 name=$4
shift 4
here=$(cd "$(dirname "$0")" && pwd)
dir=/tmp/p3rec
unit=p3rec-$name
run="XDG_RUNTIME_DIR=/run/user/1001"

mrssh "$box" "mkdir -p $dir"
mrscp "$here/record-bus.py" "mrstation@$box:$dir/record-bus.py"
# shellcheck disable=SC2029
mrssh "$box" "$run systemd-run --user --unit=$unit --collect sh -c 'python3 $dir/record-bus.py $sock $secs $dir/$name $* >$dir/$name.log 2>&1'"
# The unit ends at its duration; a minute's grace for the files to close.
end=$(($(date +%s) + ${secs%.*} + 60))
while mrssh "$box" "$run systemctl --user is-active --quiet $unit"; do
    [ "$(date +%s)" -lt "$end" ] || { echo "record-bus.sh: $unit still running on $box" >&2; exit 1; }
    sleep 5
done
files="$name.ts $name.bus.jsonl $name.log"
case " $* " in *" --demux "*) files="$files $name.pads.jsonl" ;; esac
for f in $files; do
    mrscp "mrstation@$box:$dir/$f" "./$f"
done
mrssh "$box" "cd $dir && rm -f $files"
cat "$name.log"
grep -q '^record-bus: [0-9]* buffers, ' "$name.log"
