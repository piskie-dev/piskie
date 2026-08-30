export function numberLine(lineNumber: number, text: string): string {
  return `${String(lineNumber).padStart(6, ' ')}\t${text}`;
}

export function containsLineNumberPrefix(text: string): boolean {
  return /^\s*\d+\t/m.test(text);
}
