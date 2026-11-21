"use client";

import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "../../atoms/Button";
import { Radio } from "../../atoms/Radio";
import { Textarea } from "../../atoms/Textarea";
import { Alert } from "../../molecules/Alert";
import { Dialog } from "../../molecules/Dialog";
import { FormField } from "../../molecules/FormField";

export const REPORT_REASON_OPTIONS = [
  { value: "SEXUAL", label: "Sexual or adult content" },
  { value: "HATE", label: "Hateful or discriminatory" },
  { value: "HARASSMENT", label: "Harassment or bullying" },
  { value: "VIOLENCE", label: "Violent or threatening" },
  { value: "SCAM_OR_PAYMENT", label: "Scam, or asks for real payment" },
  { value: "PERSONAL_INFO", label: "Shows someone's personal information" },
  { value: "IMPERSONATION", label: "Pretends to be a real person or company" },
  { value: "COPYRIGHT", label: "Copies someone else's work" },
  { value: "OTHER", label: "Something else" },
] as const;

export type ReportReasonValue = (typeof REPORT_REASON_OPTIONS)[number]["value"];

export type ReportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The element that opens the dialog. */
  trigger?: ReactNode;
  /** What is being reported, in words: "Pocket Cloud" or "the shop Cloud Nine". */
  targetName: string;
  onSubmit: (reason: ReportReasonValue, detail: string) => void;
  busy?: boolean;
  /** A refused report, in plain words. */
  error?: string | null;
  /** Set once the report is accepted: the confirmation replaces the form. */
  reference?: string | null;
  detailMax?: number;
};

/** Reason (radio list), optional detail with a count, then a confirmation with the case reference. */
export function ReportDialog({
  open,
  onOpenChange,
  trigger,
  targetName,
  onSubmit,
  busy = false,
  error = null,
  reference = null,
  detailMax = 500,
}: ReportDialogProps) {
  const [reason, setReason] = useState<ReportReasonValue | "">("");
  const [detail, setDetail] = useState("");
  const [tried, setTried] = useState(false);
  const count = [...detail].length;
  const detailProblem =
    count > detailMax ? `Use ${detailMax} characters or fewer (${count - detailMax} too many).` : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (reason === "" || detailProblem) return;
    onSubmit(reason, detail.trim());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      {...(trigger ? { trigger } : {})}
      title={reference ? "Report received" : `Report ${targetName}`}
      description={reference ? undefined : "Tell us what is wrong. A person on our team reads every report."}
    >
      {reference ? (
        <div className="flex flex-col gap-3 font-body">
          <Alert tone="success" title="Thank you. We have your report.">
            Your case reference is <strong data-testid="report-reference">{reference}</strong>.
          </Alert>
          <p className="text-sm text-fg">We do not tell the seller who reported.</p>
          <Button type="button" className="self-start" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4 font-body">
          <fieldset className="flex flex-col">
            <legend className="mb-1 text-sm font-medium text-fg">
              What is the problem? <span className="text-danger">(required)</span>
            </legend>
            {REPORT_REASON_OPTIONS.map((o) => (
              <Radio
                key={o.value}
                name="report-reason"
                value={o.value}
                label={o.label}
                checked={reason === o.value}
                onChange={() => setReason(o.value)}
              />
            ))}
            {tried && reason === "" ? (
              <p role="alert" className="text-sm font-medium text-danger">
                Pick the closest reason.
              </p>
            ) : null}
          </fieldset>
          <FormField
            label="More detail (optional)"
            hint={`${count} of ${detailMax} characters. Do not include phone numbers, emails or addresses.`}
            error={tried ? detailProblem : null}
          >
            {(control) => (
              <Textarea {...control} rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} />
            )}
          </FormField>
          <p className="text-sm text-fg-muted">We do not tell the seller who reported.</p>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={busy}>
              Send report
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
