import type { ReactNode } from "react";
import { Banner } from "@/components/ui/primitives";
import { githubAppConfigured } from "@/lib/github/app-config";
import { userTokenKey } from "@/lib/github/user-token";
import { isDemo } from "@/lib/env";
import { isHosted } from "@/lib/public-url";
import { LinkGithubForm } from "./GithubLinkForms";

/** Whether this server lets people link their own GitHub account (hosted, the App is set up, an encryption key is configured). */
export const canLinkGithub = () => isHosted() && !isDemo() && githubAppConfigured() && userTokenKey() !== null;

/**
 * The note on My attention and Inbox for a person without a linked GitHub account. Where linking exists it carries the "Link GitHub"
 * action (the button sits under the text on a narrow screen: Banner does that); otherwise it is the plain explanation.
 */
export function LinkGithubBanner({ children }: { children: ReactNode }) {
  return (
    <Banner tone="info" title="Personal review queues need a linked GitHub account." action={canLinkGithub() ? <LinkGithubForm primary={false} /> : undefined}>
      {children}
    </Banner>
  );
}
