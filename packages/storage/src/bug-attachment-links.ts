// Include acceptance evidence without changing immutable original Bug attachments.
export const BUG_ATTACHMENT_LINKS_SQL = `(
  SELECT account_id, project_id, bug_id, attachment_id, binding_id, NULL AS verification_id
  FROM bug_attachments
  UNION ALL
  SELECT link.account_id, link.project_id, verification.bug_id,
    link.attachment_id, link.binding_id, link.verification_id
  FROM verification_attachments AS link
  JOIN verifications AS verification ON verification.account_id = link.account_id
    AND verification.project_id = link.project_id AND verification.id = link.verification_id
)`;
