"use client";

import { useState } from "react";
import { commentAction } from "@/app/actions";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { BODY_MAX, withFooter } from "@/lib/github/write-text";

/**
 * A comment that goes to GitHub as the person: write it, review exactly what will be posted (repository, item, the text with its footer),
 * then confirm. Nothing is sent until the confirmation sheet's button is pressed.
 */
export function GithubCommentBox({ id, repoName, number }: { id: string; repoName: string; number: number }) {
  const [body, setBody] = useState("");
  const [open, setOpen] = useState(false);
  const empty = body.trim().length === 0;
  return (
    <div>
      <label className="label" htmlFor="comment-body">Add a comment</label>
      <textarea id="comment-body" className="textarea" value={body} maxLength={BODY_MAX} onChange={(e) => setBody(e.target.value)} />
      <p className="mt-1 text-[12px] text-ink-3">Posted on GitHub as you, after you confirm.</p>
      <div className="mt-2">
        <button type="button" className="btn btn-primary" disabled={empty} onClick={() => setOpen(true)}>Review comment</button>
      </div>
      <ConfirmSheet
        open={open}
        onOpenChange={setOpen}
        title="Post this comment on GitHub?"
        consequence={<>It will be posted on <bdi>{repoName}</bdi> #{number} under your own GitHub name. You can edit it from Mergeport later; it cannot be removed from here.</>}
        action={commentAction}
        submitLabel="Post comment"
        pendingLabel="Posting…"
        danger={false}
        onDone={(r) => {
          if (r.ok) setBody("");
        }}
      >
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="body" value={body} />
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-line p-3 text-[12.5px] text-ink-2">{withFooter(body)}</pre>
      </ConfirmSheet>
    </div>
  );
}
