export interface SdnParty {
  readonly uid: number;
  readonly name: string;
  readonly solanaAddress: string;
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const publishDate = (date: Date) =>
  [date.getUTCMonth() + 1, date.getUTCDate()].map((part) => String(part).padStart(2, '0')).join('/') +
  `/${date.getUTCFullYear()}`;

export function sdnXml(parties: readonly SdnParty[], published: Date): string {
  if (parties.length === 0) throw new Error('SDN listesi en az bir kayıt ister');
  const entries = parties.map((party) =>
    [
      '  <sdnEntry>',
      `    <uid>${party.uid}</uid>`,
      `    <lastName>${escapeXml(party.name)}</lastName>`,
      '    <sdnType>Entity</sdnType>',
      '    <idList>',
      '      <id>',
      `        <uid>${party.uid + 1}</uid>`,
      '        <idType>Digital Currency Address - SOL</idType>',
      `        <idNumber>${escapeXml(party.solanaAddress)}</idNumber>`,
      '      </id>',
      '    </idList>',
      '  </sdnEntry>',
    ].join('\n'),
  );
  return [
    '<?xml version="1.0" standalone="yes"?>',
    '<sdnList>',
    '  <publshInformation>',
    `    <Publish_Date>${publishDate(published)}</Publish_Date>`,
    `    <Record_Count>${parties.length}</Record_Count>`,
    '  </publshInformation>',
    ...entries,
    '</sdnList>',
    '',
  ].join('\n');
}
