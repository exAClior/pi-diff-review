export function getExplanationReplyDraft(reply) {
  if (typeof reply?.draftBody === "string") {
    return reply.draftBody;
  }

  return typeof reply?.body === "string" ? reply.body : "";
}

export function getSubmittedExplanationReplyBody(reply) {
  return typeof reply?.body === "string" ? reply.body.trim() : "";
}

export function hasPendingExplanationReplyChanges(reply) {
  return getExplanationReplyDraft(reply).trim() !== getSubmittedExplanationReplyBody(reply);
}

export function isExplanationReplySubmitted(reply) {
  const submittedBody = getSubmittedExplanationReplyBody(reply);
  return submittedBody.length > 0 && hasPendingExplanationReplyChanges(reply) === false;
}

export function hasStartedExplanationReplyDraft(reply) {
  return getExplanationReplyDraft(reply).trim().length > 0;
}

export function needsExplanationReplySubmission(reply) {
  return (
    hasPendingExplanationReplyChanges(reply) &&
    (hasStartedExplanationReplyDraft(reply) || getSubmittedExplanationReplyBody(reply).length > 0)
  );
}

export function submitExplanationReplyDraft(reply) {
  const nextBody = getExplanationReplyDraft(reply).trim();
  reply.body = nextBody;
  reply.draftBody = nextBody;
  return nextBody;
}

export function describeExplanationReplySubmissionState(reply) {
  const draftBody = getExplanationReplyDraft(reply).trim();
  const submittedBody = getSubmittedExplanationReplyBody(reply);

  if (draftBody.length === 0) {
    if (submittedBody.length > 0) {
      return {
        tone: "pending",
        label: "Edited",
        hint: "Submit again to remove this reply from the review, or keep editing it.",
        buttonLabel: "Remove reply",
        buttonDisabled: false,
      };
    }

    return {
      tone: "draft",
      label: "Draft",
      hint: "Add text, then submit this reply to include it in the review.",
      buttonLabel: "Submit reply",
      buttonDisabled: true,
    };
  }

  if (draftBody === submittedBody && submittedBody.length > 0) {
    return {
      tone: "submitted",
      label: "Submitted",
      hint: "Included when you submit the review so pi can revise this explanation.",
      buttonLabel: "Submitted",
      buttonDisabled: true,
    };
  }

  if (submittedBody.length > 0) {
    return {
      tone: "pending",
      label: "Edited",
      hint: "Submit again to include the latest reply in the review.",
      buttonLabel: "Save changes",
      buttonDisabled: false,
    };
  }

  return {
    tone: "draft",
    label: "Draft",
    hint: "Submit this reply to include it in the review.",
    buttonLabel: "Submit reply",
    buttonDisabled: false,
  };
}
