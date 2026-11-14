// Fictional sample messages. Every name, number and address below is invented for the demo.

export interface Sample {
  id: string;
  label: string;
  task: TaskId;
  text: string;
}

export type TaskId = 'reply' | 'summary' | 'actions' | 'custom';

export const SAMPLES: Sample[] = [
  {
    id: 'clinic',
    label: 'Clinic inbox',
    task: 'reply',
    text: `Hi team, patient Maria Delgado (DOB 03/14/1981) called from 415-555-0142 about her refill. She lives at 22 Alder Lane, Fresno, CA 93711 and her member ID is HX-4471-9920. Her daughter Sofia emailed sofia.delgado@examplemail.com saying Dr. Kenji Watanabe at Valley Clinic changed her metformin dose from 500 mg to 1000 mg twice daily last week, but the pharmacy still has the old prescription. Maria is worried about running out before Friday and wants a call back.`,
  },
  {
    id: 'support',
    label: 'Support ticket',
    task: 'reply',
    text: `From: Priya Raman <priya.raman@northwind-mail.com>
Subject: Charged twice for order #A88231-7

Hello, I was charged twice ($184.20 each) for order #A88231-7 on November 2, 2026. The card ending 4242 shows both charges. I already called your line from +1 (646) 555-0199 and an agent named Tomasz said a refund would take 3 days, but it has been 9. Please ship the replacement blender to 1480 Harbor View Drive, Apt 5C, Oakland, CA 94607 instead of my old address. My account is 77310045. Thanks, Priya`,
  },
  {
    id: 'hr',
    label: 'HR complaint',
    task: 'summary',
    text: `Confidential — for People Ops only.

On 10/28/2026 Daniel Okafor (employee ID EMP-20417) reported that his manager, Rebecca Lindqvist, repeatedly scheduled him for weekend on-call shifts after he disclosed a medical condition. Daniel says the pattern started after his meeting with Rebecca on September 30, 2026. Two teammates, Luis Ferreira and Hannah Cho, are willing to confirm that weekend rotations were previously shared evenly. Daniel can be reached at 312-555-0178 or daniel.okafor@contoso-hr.example. He asked that his name not be shared with Rebecca until an investigator is assigned. Current rota is attached in the Westfield Logistics shared drive.`,
  },
  {
    id: 'legal',
    label: 'Tenant letter',
    task: 'actions',
    text: `Dear Mr. Haddad,

I am writing about the unit at 9 Linden Court, Unit 3, Burlington, VT 05401, which I have rented since June 1, 2023. Since August 2026 the heating has failed four times, most recently on November 6, 2026, when the temperature inside fell to 54°F. I reported each failure to your property manager, Ellen Brooks, at ebrooks@lindenmgmt.example and at 802-555-0136. My lease number is LC-2023-0611. I have paid rent in full every month. If the heating is not permanently repaired within 14 days I will contact the city housing inspector and place future rent in escrow, as allowed by state law.

Sincerely,
Grace Whitfield`,
  },
];

export interface Task {
  id: TaskId;
  label: string;
  hint: string;
  instruction: string;
}

export const TASKS: Task[] = [
  {
    id: 'reply',
    label: 'Draft a reply',
    hint: 'A ready-to-send response',
    instruction:
      'Write a warm, clear and professional reply to this message from the organization that received it. Address people using their placeholders, confirm the concrete next steps and any details that matter, and keep it under 180 words.',
  },
  {
    id: 'summary',
    label: 'Summarize',
    hint: 'Key facts in five bullets',
    instruction:
      'Summarize this message for a busy colleague in at most five short bullet points, then add one line starting with "Risk:" that flags anything time-sensitive or sensitive.',
  },
  {
    id: 'actions',
    label: 'Action items',
    hint: 'Who does what, by when',
    instruction:
      'Extract every action item as a Markdown checklist. For each, say who should do it (use placeholders), what exactly, and any deadline mentioned. End with one line naming the single most urgent item.',
  },
  { id: 'custom', label: 'Custom', hint: 'Write your own instruction', instruction: '' },
];
