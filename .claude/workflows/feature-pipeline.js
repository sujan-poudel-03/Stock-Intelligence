export const meta = {
  name: 'feature-pipeline',
  description: 'Product Owner scopes -> Principal Architect designs -> Senior Engineer implements -> QA Reviewer checks, for one feature/fix in this repo',
  whenToUse: 'Use for a nontrivial feature, a bug fix with real UX surface, or any change where role-based sign-off (scope, architecture, implementation, adversarial review) is wanted instead of jumping straight to code.',
  phases: [
    { title: 'Define', detail: 'Product Owner scopes the request' },
    { title: 'Design', detail: 'Principal Architect designs the approach + task list' },
    { title: 'Implement', detail: 'Senior Engineer implements the task list' },
    { title: 'Review', detail: 'QA Reviewer adversarially checks the result' },
  ],
}

const SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    primaryAction: { type: 'string' },
    secondaryActions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          dependsOnPrimary: { type: 'boolean' },
          mustBeNested: { type: 'boolean' },
        },
        required: ['action', 'dependsOnPrimary', 'mustBeNested'],
      },
    },
    nonGoals: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['goal', 'primaryAction', 'secondaryActions', 'nonGoals', 'acceptanceCriteria'],
}

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    approach: { type: 'string' },
    tradeoffs: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'number' },
          description: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['step', 'description', 'files'],
      },
    },
    verificationCommands: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['approach', 'tasks', 'verificationCommands'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    scopeSatisfied: { type: 'boolean' },
    // Per-criterion validation: every acceptance criterion from the scope must be
    // named and given a status backed by concrete evidence (a command output, a
    // code path, a forced-failure observation). This is the real definition of
    // done — a single scopeSatisfied boolean lets "mostly working" slip through.
    criteriaValidation: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          status: { type: 'string' }, // PASS | FAIL | PARTIAL | UNVERIFIED
          evidence: { type: 'string' }, // how you proved it — output, path, or observed behavior
        },
        required: ['criterion', 'status', 'evidence'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string' },
          summary: { type: 'string' },
          location: { type: 'string' },
          failureScenario: { type: 'string' },
        },
        required: ['severity', 'summary'],
      },
    },
    verdict: { type: 'string' },
  },
  required: ['scopeSatisfied', 'criteriaValidation', 'findings', 'verdict'],
}

// Security review runs alongside QA in the Review phase. For a product that moves
// money and ingests untrusted web content into prompts, a change is not shippable
// until this passes, independent of whether it satisfies the functional scope.
const SECURITY_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string' },
          summary: { type: 'string' },
          location: { type: 'string' },
          exploitScenario: { type: 'string' },
          remediation: { type: 'string' },
        },
        required: ['severity', 'summary'],
      },
    },
    verdict: { type: 'string' },
  },
  required: ['passed', 'findings', 'verdict'],
}

const request = typeof args === 'string' ? args : (args && args.request) || ''
if (!request) {
  throw new Error('feature-pipeline requires args.request (or a plain string) describing the feature/fix to scope')
}

phase('Define')
log(`Scoping: ${request}`)
const scope = await agent(
  `Scope this request for this codebase: ${request}`,
  { agentType: 'product-owner', schema: SCOPE_SCHEMA, phase: 'Define' },
)

phase('Design')
const design = await agent(
  `Design the technical approach and task list for this scoped request.\n\nScope:\n${JSON.stringify(scope, null, 2)}`,
  { agentType: 'principal-architect', schema: DESIGN_SCHEMA, phase: 'Design' },
)

phase('Implement')
let implementation = await agent(
  `Implement exactly this task list in this repo.\n\nDesign:\n${JSON.stringify(design, null, 2)}`,
  { agentType: 'senior-engineer', phase: 'Implement' },
)

// Run QA (functional/scope) and security review together — both must pass. QA
// validates acceptance criteria + behavior; security checks the money/data/
// prompt-injection surface. A change ships only when neither has a blocking issue.
const HIGH = new Set(['high', 'blocker', 'critical']);
const isBlockingFinding = (f) => HIGH.has(String(f.severity).toLowerCase());

async function runReviews(impl, suffix) {
  const [qa, security] = await Promise.all([
    agent(
      `Review this implementation against the original scope and design.\n\nScope:\n${JSON.stringify(scope, null, 2)}\n\nDesign:\n${JSON.stringify(design, null, 2)}\n\nImplementation report:\n${impl}`,
      { agentType: 'qa-reviewer', schema: REVIEW_SCHEMA, phase: 'Review', label: `qa-reviewer${suffix}` },
    ),
    agent(
      `Security-review this implementation. Focus on the money/data/untrusted-input surface: secret handling, the CRON_SECRET auth guard on cron/worker/brief, prompt injection from scraped web content influencing signals, hollow/hallucinated-price persistence, and the no-RLS anon-key exposure.\n\nScope:\n${JSON.stringify(scope, null, 2)}\n\nDesign:\n${JSON.stringify(design, null, 2)}\n\nImplementation report:\n${impl}`,
      { agentType: 'security-reviewer', schema: SECURITY_SCHEMA, phase: 'Review', label: `security-reviewer${suffix}` },
    ),
  ]);
  return { qa, security };
}

// Combined gate: unmet acceptance criteria, or a blocking QA/security finding, or
// an explicit security fail. UNVERIFIED criteria are surfaced, not auto-blocking.
function evaluate({ qa, security }) {
  const unmetCriteria = (qa.criteriaValidation || []).filter((c) =>
    ['fail', 'partial'].includes(String(c.status).toLowerCase()),
  );
  const unverifiedCriteria = (qa.criteriaValidation || []).filter(
    (c) => String(c.status).toLowerCase() === 'unverified',
  );
  const blocked =
    !qa.scopeSatisfied ||
    security.passed === false ||
    qa.findings.some(isBlockingFinding) ||
    security.findings.some(isBlockingFinding) ||
    unmetCriteria.length > 0;
  return { unmetCriteria, unverifiedCriteria, blocked };
}

phase('Review')
let reviews = await runReviews(implementation, '')
let { unmetCriteria, unverifiedCriteria, blocked } = evaluate(reviews)
if (unverifiedCriteria.length) {
  log(`Note: ${unverifiedCriteria.length} acceptance criterion/criteria could not be verified automatically — confirm manually before release.`)
}

// One bounded fix-and-reverify round if either reviewer found a blocking issue —
// not an open-ended loop, just enough to catch the common fixable miss without
// silently shipping it as "done" the first time review found something real.
if (blocked) {
  log('Review found blocking QA/security issues — sending back to senior-engineer for one fix round.')
  phase('Implement')
  implementation = await agent(
    `Fix these review findings AND satisfy every unmet acceptance criterion in your prior implementation. Address the security findings too. Do not re-scope or re-architect — only address what's listed.\n\nUnmet acceptance criteria (must reach PASS):\n${JSON.stringify(unmetCriteria, null, 2)}\n\nQA findings:\n${JSON.stringify(reviews.qa.findings, null, 2)}\n\nSecurity findings:\n${JSON.stringify(reviews.security.findings, null, 2)}\n\nOriginal task list:\n${JSON.stringify(design, null, 2)}`,
    { agentType: 'senior-engineer', phase: 'Implement', label: 'senior-engineer:fix-round' },
  )
  phase('Review')
  reviews = await runReviews(implementation, ':re-review')
  ;({ unmetCriteria, unverifiedCriteria, blocked } = evaluate(reviews))
}

return { scope, design, review: reviews.qa, security: reviews.security, implementation, blocked }
