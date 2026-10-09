// Square'in sekiz adımlı akışı: docs/design/program-interface.md §3, docs/protocol.md ve analiz §4.2. Politikalı
// işlerde 7. adım (ispat bağlama), 6. adımdaki finalize'dan önce gelir; numaralar akışın kendi sırasıdır.
export interface FlowStep {
  number: number;
  title: string;
  actor: string;
  /** Adımda ne olduğu, sade dille (protocol.md'nin "Ne olur" sütunu). */
  summary: string;
  /** Adımın zincirdeki talimatları, sırasıyla. */
  instructions: readonly string[];
}

export const FLOW_STEPS: readonly FlowStep[] = [
  {
    number: 1,
    title: 'Commit the spending policy',
    actor: 'Institution',
    summary:
      'Opens the institution account and commits the policy and its public daily ceiling. The rules stay off chain.',
    instructions: ['init_institution', 'set_policy'],
  },
  {
    number: 2,
    title: 'Register the agent',
    actor: 'Agent',
    summary: 'Registers a did:aip identity with the hash of its agent card.',
    instructions: ['register_agent'],
  },
  {
    number: 3,
    title: 'Screen, open and fund the job',
    actor: 'Institution',
    summary:
      'Both wallets are screened. The institution opens and funds the job, then proves its terms fit the policy before the agent accepts.',
    instructions: ['record_screening', 'create_job', 'fund_job', 'set_preflight_proof'],
  },
  {
    number: 4,
    title: 'Accept and deliver the work',
    actor: 'Agent',
    summary: 'Accepts the job and delivers the hash and address of the work. The challenge window opens.',
    instructions: ['accept_job', 'submit_work'],
  },
  {
    number: 5,
    title: 'Sell the receivable',
    actor: 'Agent / buyer',
    summary: 'Optionally sells the right to the payment, at a discount, to a buyer the policy approves.',
    instructions: ['list_claim', 'buy_claim'],
  },
  {
    number: 6,
    title: 'Finalize after the challenge window',
    actor: 'Keeper',
    summary: 'After the challenge window anyone can finalize the payment and earn the keeper fee.',
    instructions: ['finalize_payment'],
  },
  {
    number: 7,
    title: 'Bind the compliance proof',
    actor: 'Institution software',
    summary: 'Proves the payment complies with the private mandate, before the job is finalized.',
    instructions: ['set_compliance_proof'],
  },
  {
    number: 8,
    title: 'Pay out and record reputation',
    actor: 'Chain',
    summary: "Pays the payee and writes the agent's reputation, the validation record and the daily counter.",
    instructions: ['finalize_payment', 'record_release'],
  },
];
