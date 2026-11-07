-- Execution plans belong to persisted chat conversations. Earlier versions
-- incorrectly referenced conversation_states, so valid chat IDs were rejected.
DO $$
BEGIN
  IF to_regclass('public.execution_plans') IS NOT NULL
     AND to_regclass('public.chat_conversations') IS NOT NULL THEN
    ALTER TABLE execution_plans
      DROP CONSTRAINT IF EXISTS execution_plans_conversation_id_fkey;
    ALTER TABLE execution_plans
      ADD CONSTRAINT execution_plans_conversation_id_fkey
      FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id)
      ON DELETE SET NULL;
  END IF;
END $$;
