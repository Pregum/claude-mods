import type { WnTools } from '../types'

const READ_SHELL =
  /^(cat|head|tail|less|grep|rg|ugrep|find|ls|wc|sed -n|awk|jq|which|pwd|echo|diff|git (log|status|diff|show|branch|fetch|ls-remote)|gh \S+ (view|list)|gh api|curl -s)\b/
const WRITE_SHELL = /(sed -i|\btee\b|\brm\b|\bmv\b|\bcp\b|\brsync\b|\bmkdir\b|\btouch\b|>>?\s*[^&|\s]|<<)/

/** Bash をコマンドの中身で分ける。書くものは編集、読むだけなら調査、それ以外は実行 */
export const shellKind = (command: string): keyof WnTools => {
  if (/\b(git (commit|push)|gh (pr|repo|release)|npm|pnpm|yarn|claude plugin|tsc|make|cargo|pytest)\b/.test(command)) {
    return 'run'
  }
  if (WRITE_SHELL.test(command.replace(/2>\s*\S+|>\s*\/dev\/null/g, ''))) return 'edit'
  const steps = command
    .split(/&&|\|\||;|\||\n/)
    .map(step => step.trim().replace(/^[A-Z_]+=\S*\s+/, ''))
    .filter(step => step !== '' && !step.startsWith('cd '))
  return steps.length > 0 && steps.every(step => READ_SHELL.test(step)) ? 'read' : 'run'
}
