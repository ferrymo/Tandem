-- Keep task attachment reference changes in the append-only task lifecycle.
ALTER TABLE tandem.wm_task_events DROP CONSTRAINT wm_task_events_kind_check;
ALTER TABLE tandem.wm_task_events ADD CONSTRAINT wm_task_events_kind_check
  CHECK (kind IN ('created','updated','comment','effort','attachment_added','attachment_removed'));
