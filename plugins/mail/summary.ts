const MAX_MESSAGES = 3;
const MAX_SENDER_LENGTH = 40;
const MAX_SUBJECT_LENGTH = 80;

interface MailMessage {
  id: string;
  from: string;
  subject: string;
  urgent: boolean;
}

export function renderSummary(messages: readonly MailMessage[], command: string): string {
  if (messages.length === 0) return "";

  const urgent = messages.filter((message) => message.urgent);
  const routine = messages.filter((message) => !message.urgent);
  const shown = [...urgent, ...routine].slice(0, MAX_MESSAGES);
  const heading = `${messages.length} pending mail message${messages.length === 1 ? "" : "s"}${messages.length > shown.length ? ` (showing ${shown.length})` : ""}:`;
  const summaries = shown.map((message) => {
    const urgency = message.urgent ? "[URGENT] " : "";
    return `- ${urgency}From ${limitText(message.from, MAX_SENDER_LENGTH)} — ${limitText(message.subject, MAX_SUBJECT_LENGTH)}`;
  });
  return [
    "MAIL — peer-provided sender and subject:",
    heading,
    ...summaries,
    `Inbox: ${command}`,
  ].join("\n");
}

function limitText(text: string, maximumLength: number): string {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maximumLength) return normalized;
  return `${characters.slice(0, maximumLength - 1).join("")}…`;
}
