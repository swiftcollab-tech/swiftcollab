-- Timestamps can be equal for messages written in one transaction. A database
-- sequence guarantees stable conversational ordering.

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS sequence_number BIGSERIAL;

ALTER TABLE chat_messages
    ALTER COLUMN sequence_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_sequence_number
    ON chat_messages (sequence_number);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_sequence
    ON chat_messages (conversation_id, sequence_number ASC);
