"use client";

import { Alert, Button, FormField, Heading, Input, Switch, Text } from "@delulu/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api, describeError } from "../../_lib/api";
import { refreshSession, useSession } from "../../_lib/session-store";
import { LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

interface Profile {
  handle: string | null;
  privacy: { publicShelf: boolean; showCollectorLevel: boolean; showHandleOnPurchases: boolean };
  researchOptOut: boolean;
}

const HANDLE_RULE = /^[a-z0-9-]{3,24}$/;
const RULES = "3 to 24 characters: lowercase letters, digits and hyphens.";

const SWITCHES: { key: keyof Profile["privacy"]; label: string; hint: string }[] = [
  {
    key: "publicShelf",
    label: "Show my collection on a public shelf",
    hint: "Anyone with the link can see what you own.",
  },
  {
    key: "showCollectorLevel",
    label: "Show my collector level",
    hint: "Your level appears next to your handle.",
  },
  {
    key: "showHandleOnPurchases",
    label: "Show my handle on purchases",
    hint: "Sellers see your handle, not your name, on orders.",
  },
];

/** The signed-in person's own handle, privacy switches and research opt-out. */
export function ProfilePanel() {
  const session = useSession();
  const signedIn = session.status === "signedIn" ? session : null;
  const [saved, setSaved] = useState<Profile | null>(null);
  const [handle, setHandle] = useState("");
  const [privacy, setPrivacy] = useState<Profile["privacy"] | null>(null);
  const [optOut, setOptOut] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);
  const handleRef = useRef<HTMLInputElement>(null);
  const signedInNow = signedIn !== null;

  function adopt(profile: Profile) {
    setSaved(profile);
    setHandle(profile.handle ?? "");
    setPrivacy(profile.privacy);
    setOptOut(profile.researchOptOut);
  }

  // An empty update returns the profile as it is now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: adopt only calls state setters
  useEffect(() => {
    if (!signedInNow) return;
    let cancelled = false;
    api<Profile>("/api/v1/profile", { method: "POST", body: {} })
      .then((profile) => {
        if (!cancelled) adopt(profile);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [signedInNow]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || !privacy) return;
    setSuccess(false);
    setFormError(null);
    const wanted = handle.trim();
    if (wanted !== "" && wanted !== (saved.handle ?? "") && !HANDLE_RULE.test(wanted)) {
      setHandleError(`That handle does not fit the rules. Use ${RULES.toLowerCase()}`);
      handleRef.current?.focus();
      return;
    }
    setHandleError(null);
    const body: Record<string, unknown> = {};
    if (wanted !== "" && wanted !== (saved.handle ?? "")) body.handle = wanted;
    body.privacy = privacy;
    if (optOut !== saved.researchOptOut) body.researchOptOut = optOut;
    setSaving(true);
    try {
      const next = await api<Profile>("/api/v1/profile", { method: "POST", body });
      adopt(next);
      setSuccess(true);
      void refreshSession();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFLICT") {
        setHandleError("That handle is not available. Try another one.");
        handleRef.current?.focus();
      } else if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
        setHandleError(`That handle does not fit the rules. Use ${RULES.toLowerCase()}`);
        handleRef.current?.focus();
      } else {
        setFormError(`${describeError(err)} Your changes were not saved.`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Profile</PageHeading>
      {signedIn?.account ? (
        <Text size="sm" muted>
          DeluluPay id {signedIn.account.delulupayId}
        </Text>
      ) : null}
      {loadError ? <Alert tone="danger">{loadError}</Alert> : null}
      {!saved || !privacy ? (
        loadError ? null : (
          <LoadingBlock rows={3} label="Loading your profile" />
        )
      ) : (
        <form onSubmit={(e) => void save(e)} className="flex max-w-reading flex-col gap-6" noValidate>
          <section aria-labelledby="handle" className="flex flex-col gap-2">
            <Heading level={2} size="md" id="handle">
              Your handle
            </Heading>
            <FormField label="Handle" hint={`${RULES} It must be unique.`} error={handleError}>
              {(control) => (
                <Input
                  {...control}
                  ref={handleRef}
                  value={handle}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={24}
                  className="font-mono"
                  onChange={(e) => {
                    setHandle(e.target.value);
                    setHandleError(null);
                    setSuccess(false);
                  }}
                />
              )}
            </FormField>
          </section>

          <section aria-labelledby="privacy" className="flex flex-col gap-3">
            <Heading level={2} size="md" id="privacy">
              Privacy
            </Heading>
            {SWITCHES.map((item) => (
              <div key={item.key} className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span id={`switch-${item.key}`} className="block text-fg">
                    {item.label}
                  </span>
                  <span id={`switch-${item.key}-hint`} className="block text-sm text-fg-muted">
                    {item.hint}
                  </span>
                </span>
                <Switch
                  aria-labelledby={`switch-${item.key}`}
                  aria-describedby={`switch-${item.key}-hint`}
                  checked={privacy[item.key]}
                  onCheckedChange={(on) => {
                    setPrivacy({ ...privacy, [item.key]: on });
                    setSuccess(false);
                  }}
                />
              </div>
            ))}
          </section>

          <section aria-labelledby="research" className="flex flex-col gap-3">
            <Heading level={2} size="md" id="research">
              Research
            </Heading>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span id="switch-research" className="block text-fg">
                  Opt out of research about how people play
                </span>
                <span id="switch-research-hint" className="block text-sm text-fg-muted">
                  When on, your play is left out of de-identified research.
                </span>
              </span>
              <Switch
                aria-labelledby="switch-research"
                aria-describedby="switch-research-hint"
                checked={optOut}
                onCheckedChange={(on) => {
                  setOptOut(on);
                  setSuccess(false);
                }}
              />
            </div>
          </section>

          <div role="status" aria-live="polite">
            {success ? (
              <Alert tone="success" title="Saved">
                Your profile is up to date.
              </Alert>
            ) : null}
          </div>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Button type="submit" variant="cta" size="lg" loading={saving} className="self-start">
            Save changes
          </Button>
        </form>
      )}
    </div>
  );
}
