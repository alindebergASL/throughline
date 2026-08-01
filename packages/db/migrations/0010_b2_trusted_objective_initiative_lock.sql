-- Established row-lock capability for durable Initiative truth mutations.
CREATE POLICY initiatives_app_truth_lock ON work.initiatives
AS PERMISSIVE FOR UPDATE TO throughline_app
USING (
  tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
  AND space_id = ops.current_space_id()
  AND EXISTS (
    SELECT 1 FROM access.spaces governing_space
    WHERE governing_space.tenant_id = work.initiatives.tenant_id
      AND governing_space.workspace_id = work.initiatives.workspace_id
      AND governing_space.id = work.initiatives.space_id
      AND governing_space.archived_at IS NULL
  )
)
WITH CHECK (false);

CREATE POLICY initiatives_app_permanent_no_write ON work.initiatives
AS RESTRICTIVE FOR UPDATE TO throughline_app
USING (true)
WITH CHECK (false);

GRANT UPDATE (id) ON work.initiatives TO throughline_app;
