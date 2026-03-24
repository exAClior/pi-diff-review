export function getCommentDraft(comment) {
  if (typeof comment?.draftBody === "string") {
    return comment.draftBody;
  }

  return typeof comment?.body === "string" ? comment.body : "";
}

export function getSubmittedCommentBody(comment) {
  return typeof comment?.body === "string" ? comment.body.trim() : "";
}

export function hasPendingCommentChanges(comment) {
  return getCommentDraft(comment).trim() !== getSubmittedCommentBody(comment);
}

export function isCommentSubmitted(comment) {
  const submittedBody = getSubmittedCommentBody(comment);
  return submittedBody.length > 0 && hasPendingCommentChanges(comment) === false;
}

export function hasStartedCommentDraft(comment) {
  return getCommentDraft(comment).trim().length > 0;
}

export function needsCommentSubmission(comment) {
  return hasPendingCommentChanges(comment) && (hasStartedCommentDraft(comment) || getSubmittedCommentBody(comment).length > 0);
}

export function submitCommentDraft(comment) {
  const nextBody = getCommentDraft(comment).trim();
  comment.body = nextBody;
  comment.draftBody = nextBody;
  return nextBody;
}

export function describeCommentSubmissionState(comment) {
  const draftBody = getCommentDraft(comment).trim();
  const submittedBody = getSubmittedCommentBody(comment);

  if (draftBody.length === 0) {
    if (submittedBody.length > 0) {
      return {
        tone: "pending",
        label: "Edited",
        hint: "Submit again to remove this comment from the review, or delete it.",
        buttonLabel: "Remove comment",
        buttonDisabled: false,
      };
    }

    return {
      tone: "draft",
      label: "Draft",
      hint: "Add text, then submit this comment to include it in the review.",
      buttonLabel: "Submit comment",
      buttonDisabled: true,
    };
  }

  if (draftBody === submittedBody && submittedBody.length > 0) {
    return {
      tone: "submitted",
      label: "Submitted",
      hint: "Included when you submit the review.",
      buttonLabel: "Submitted",
      buttonDisabled: true,
    };
  }

  if (submittedBody.length > 0) {
    return {
      tone: "pending",
      label: "Edited",
      hint: "Submit again to include the latest text in the review.",
      buttonLabel: "Save changes",
      buttonDisabled: false,
    };
  }

  return {
    tone: "draft",
    label: "Draft",
    hint: "Submit this comment to include it in the review.",
    buttonLabel: "Submit comment",
    buttonDisabled: false,
  };
}
