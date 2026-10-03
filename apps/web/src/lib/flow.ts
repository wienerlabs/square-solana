// Square'in sekiz adımlı akışı: docs/design/program-interface.md §3 ve analiz §4.2. Politikalı işlerde
// 7. adım (ispat bağlama), 6. adımdaki finalize'dan önce gelir; numaralar akışın kendi sırasıdır.
export interface FlowStep {
  number: number;
  title: string;
  actor: string;
  instructions: string;
}

export const FLOW_STEPS: readonly FlowStep[] = [
  {
    number: 1,
    title: 'Commit the spending policy',
    actor: 'Institution',
    instructions: 'init_institution · set_policy',
  },
  { number: 2, title: 'Register the agent', actor: 'Agent', instructions: 'register_agent' },
  {
    number: 3,
    title: 'Screen, open and fund the job',
    actor: 'Institution',
    instructions: 'record_screening · create_job · fund_job',
  },
  { number: 4, title: 'Accept and deliver the work', actor: 'Agent', instructions: 'accept_job · submit_work' },
  { number: 5, title: 'Sell the receivable', actor: 'Agent / buyer', instructions: 'list_claim · buy_claim' },
  { number: 6, title: 'Finalize after the challenge window', actor: 'Keeper', instructions: 'finalize_payment' },
  {
    number: 7,
    title: 'Bind the compliance proof',
    actor: 'Institution software',
    instructions: 'set_compliance_proof',
  },
  {
    number: 8,
    title: 'Pay out and record reputation',
    actor: 'Chain',
    instructions: 'finalize_payment · record_release',
  },
];
