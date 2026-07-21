-- Persist bounded Slack thread discovery independently from reviewer-supplied
-- anchor threads. Production migrations are forward-only. A development-only
-- rollback may drop discovered_thread_timestamps and restore anchor_index <= 5
-- before any collection created by this release exists; doing so afterwards
-- discards resumable collection state.

ALTER TABLE source_collection_checkpoints
    ADD COLUMN discovered_thread_timestamps TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE source_collection_checkpoints
    ADD CONSTRAINT source_collection_checkpoints_discovered_threads_valid CHECK (
        cardinality(discovered_thread_timestamps) <= 500
        AND array_position(discovered_thread_timestamps, NULL) IS NULL
        AND (
            cardinality(discovered_thread_timestamps) = 0
            OR array_to_string(discovered_thread_timestamps, ',')
                ~ '^[0-9]{1,20}\.[0-9]{1,20}(,[0-9]{1,20}\.[0-9]{1,20})*$'
        )
    );

ALTER TABLE source_collection_checkpoints
    DROP CONSTRAINT source_collection_checkpoints_anchor_index_check;

ALTER TABLE source_collection_checkpoints
    ADD CONSTRAINT source_collection_checkpoints_anchor_index_valid CHECK (
        anchor_index >= 0 AND anchor_index <= 505
    );
