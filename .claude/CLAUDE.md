## SSH to media-router hosts

Always use `mrssh` and `mrscp` for SSH/SCP to media-router hosts.
Do not call `sshpass`, `ssh`, or `scp` directly.

  mrssh <ip> '<command>'
  mrscp <src> <dst>
