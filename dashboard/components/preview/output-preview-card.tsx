import { ExternalLink, FileImage } from "lucide-react";
import type { ProviderPreview } from "@/lib/settings-preview";

export function OutputPreviewCard({ preview }: { preview: ProviderPreview; locale?: unknown }) {
  return (
    <div className="rounded-md bg-[#313338] p-3 text-[#dbdee1] shadow-soft">
      <div className="flex gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#5865f2] text-xs font-bold text-white">
          CB
        </div>

        <div className="min-w-0 flex-1">
          {preview.replyContext ? (
            <div className="mb-1 text-xs text-[#949ba4]">{preview.replyContext}</div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 text-sm leading-none">
            <span className="font-semibold text-white">{preview.botName}</span>
            <span className="rounded bg-[#5865f2] px-1 py-0.5 text-[10px] font-bold leading-none text-white">{preview.botBadge}</span>
            <span className="text-xs text-[#949ba4]">{preview.timestamp}</span>
          </div>

          {preview.messageContent ? (
            <a className="mt-2 block break-all text-sm text-[#00a8fc]" href={preview.sourceUrl} target="_blank" rel="noreferrer">
              {preview.messageContent}
            </a>
          ) : null}

          <div className="mt-2 w-full max-w-[560px] overflow-hidden rounded bg-[#2b2d31]" style={{ borderLeft: `4px solid ${preview.accentColor}` }}>
            <div className="flex gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[#f2f3f5]">{preview.author}</div>
                <a className="mt-1 block break-words text-base font-semibold leading-5 text-[#00a8fc] hover:underline" href={preview.sourceUrl} target="_blank" rel="noreferrer">
                  {preview.title}
                </a>

                {preview.description ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-5 text-[#dbdee1]">{preview.description}</p>
                ) : null}

                {preview.linkOnlyMedia ? (
                  <div className="mt-2 break-all rounded bg-[#313338] p-2 text-xs text-[#00a8fc]">{preview.sourceUrl}</div>
                ) : null}

                {preview.fields.length ? (
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {preview.fields.map((field) => (
                      <div key={`${field.key || field.name}:${field.name}`} className={field.inline ? "min-w-0" : "sm:col-span-3"}>
                        <div className="truncate text-xs font-semibold text-[#f2f3f5]">{field.name}</div>
                        <div className="whitespace-pre-wrap break-words text-xs leading-4 text-[#dbdee1]">{field.value}</div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {preview.image ? (
                  <div className="mt-3 flex aspect-video max-h-72 items-center justify-center overflow-hidden rounded bg-gradient-to-br from-[#1e1f22] via-[#3a3d44] to-[#111214] text-sm text-[#b5bac1]">
                    {preview.image}
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-[#949ba4]">
                  <span>{preview.footer}</span>
                  <span>•</span>
                  <span>{preview.requester}</span>
                </div>
                {preview.sourceDeletedNotice ? (
                  <div className="mt-1 text-[11px] text-[#faa61a]">{preview.sourceDeletedNotice}</div>
                ) : null}
              </div>

              {preview.thumbnail ? (
                <div className="hidden h-20 w-20 shrink-0 items-center justify-center rounded bg-gradient-to-br from-[#1e1f22] to-[#454a52] text-center text-[11px] text-[#b5bac1] sm:flex">
                  {preview.thumbnail}
                </div>
              ) : null}
            </div>
          </div>

          {preview.attachments.length ? (
            <div className="mt-2 grid w-full max-w-[560px] gap-2">
              {preview.attachments.map((attachment) => (
                <div key={attachment.filename} className="flex items-center gap-3 rounded border border-[#3f4147] bg-[#2b2d31] p-2">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-[#1e1f22] text-[#b5bac1]">
                    <FileImage size={20} />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[#00a8fc]">{attachment.filename}</div>
                    <div className="truncate text-xs text-[#949ba4]">{attachment.label}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {preview.buttons.length ? (
            <div className="mt-2 flex w-full max-w-[560px] flex-wrap gap-2">
              {preview.buttons.map((button) => (
                <button
                  key={button.key}
                  className={[
                    "min-h-8 min-w-0 rounded px-3 py-1.5 text-xs font-medium leading-tight text-white",
                    button.danger ? "bg-[#da373c]" : "bg-[#4e5058]",
                  ].join(" ")}
                  disabled
                >
                  {button.label}
                </button>
              ))}
              <a className="flex min-h-8 min-w-0 items-center gap-1 rounded bg-[#4e5058] px-3 py-1.5 text-xs font-medium leading-tight text-white" href={preview.sourceUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={13} />
                {preview.sourceButtonLabel}
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
