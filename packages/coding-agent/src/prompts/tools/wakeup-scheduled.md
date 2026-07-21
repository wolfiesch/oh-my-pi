Scheduled wakeup `{{jobId}}` for {{scheduledAt}} (in {{delaySeconds}} seconds). It will wake this agent automatically while the owning session remains open.

To inspect it, use `hub` with `op="jobs"`. To cancel it, use `hub` with `op="cancel"` and `ids=["{{jobId}}"]`.
