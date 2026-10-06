// Elle yazılan zod şemaları ile docs/api/openapi.yaml bileşenlerinin birebir aynı olduğunu denetler.
// IDL kaynaklı şemalar üreteçle (gen:check) denetlenir; bu test el yazımı yüzeyi kapsar.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import * as t from '../dist/index.js';

const spec = parse(readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8'));
const components = spec.components.schemas;
const idlSchemas = JSON.parse(readFileSync(new URL('../../../docs/api/schemas/idl.json', import.meta.url), 'utf8'));
const rootPackage = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

const OBJECTS = {
  ApiError: t.ApiErrorSchema,
  ProgramErrorRef: t.ProgramErrorRefSchema,
  ResponseMeta: t.ResponseMetaSchema,
  JobView: t.JobViewSchema,
  InstitutionView: t.InstitutionViewSchema,
  PolicyMeta: t.PolicyMetaSchema,
  PolicyView: t.PolicyViewSchema,
  AgentView: t.AgentViewSchema,
  ClaimView: t.ClaimViewSchema,
  DisputeView: t.DisputeViewSchema,
  ScreeningView: t.ScreeningViewSchema,
  AgentSkill: t.AgentSkillSchema,
  AgentRegistration: t.AgentRegistrationSchema,
  AgentPricing: t.AgentPricingSchema,
  AgentCard: t.AgentCardSchema,
  AgentService: t.AgentServiceSchema,
  AgentInterface: t.AgentInterfaceSchema,
  AgentCardHosting: t.AgentCardHostingSchema,
  IndexedEvent: t.IndexedEventSchema,
  AuthChallengeRequest: t.AuthChallengeRequestSchema,
  AuthChallenge: t.AuthChallengeSchema,
  SessionRequest: t.SessionRequestSchema,
  Session: t.SessionSchema,
  ApiKey: t.ApiKeySchema,
  ApiKeyCreate: t.ApiKeyCreateSchema,
  ApiKeyCreated: t.ApiKeyCreatedSchema,
  X402Endpoint: t.X402EndpointSchema,
  X402EndpointCreate: t.X402EndpointCreateSchema,
  X402EndpointUpdate: t.X402EndpointUpdateSchema,
  X402PaymentReport: t.X402PaymentReportSchema,
  X402Payment: t.X402PaymentSchema,
  X402UsageTotal: t.X402UsageTotalSchema,
  X402EndpointUsage: t.X402EndpointUsageSchema,
  TxRequest: t.TxRequestSchema,
  UnsignedTx: t.UnsignedTxSchema,
  DeliveryReceipt: t.DeliveryReceiptSchema,
  ProveRequest: t.ProveRequestSchema,
  ProveResponse: t.ProveResponseSchema,
  KeeperAction: t.KeeperActionSchema,
  DisputeEvidence: t.DisputeEvidenceSchema,
  DisputeVoteRecord: t.DisputeVoteRecordSchema,
  ArbitrationQueueItem: t.ArbitrationQueueItemSchema,
  DisputeVoteRequest: t.DisputeVoteRequestSchema,
  ArbitrationWebhook: t.ArbitrationWebhookSchema,
  ArbitrationWebhookCreate: t.ArbitrationWebhookCreateSchema,
  ArbitrationWebhookCreated: t.ArbitrationWebhookCreatedSchema,
  ArbitrationNotification: t.ArbitrationNotificationSchema,
  Health: t.HealthSchema,
  TravelRuleAddress: t.TravelRuleAddressSchema,
  TravelRuleNationalId: t.TravelRuleNationalIdSchema,
  TravelRulePerson: t.TravelRulePersonSchema,
  TravelRuleVasp: t.TravelRuleVaspSchema,
  TravelRuleRecord: t.TravelRuleRecordSchema,
  TravelRulePut: t.TravelRulePutSchema,
  TravelRuleStatus: t.TravelRuleStatusSchema,
  TravelRuleDisclosure: t.TravelRuleDisclosureSchema,
  TravelRuleGrantCreate: t.TravelRuleGrantCreateSchema,
  TravelRuleGrant: t.TravelRuleGrantSchema,
  TravelRuleAccess: t.TravelRuleAccessSchema,
  CctpTransferCreate: t.CctpTransferCreateSchema,
  CctpTransfer: t.CctpTransferSchema,
  CctpFundTxRequest: t.CctpFundTxRequestSchema,
  CctpFundTx: t.CctpFundTxSchema,
};

const ENUMS = {
  ApiErrorCode: t.ApiErrorCodeSchema,
  ApiKeyScope: t.ApiKeyScopeSchema,
  X402Network: t.X402NetworkSchema,
  KeeperActionKind: t.KeeperActionKindSchema,
  KeeperOutcome: t.KeeperOutcomeSchema,
  KeeperReason: t.KeeperReasonSchema,
  TravelRuleIdentifierType: t.TravelRuleIdentifierTypeSchema,
  TravelRulePersonKind: t.TravelRulePersonKindSchema,
  TravelRuleAccessAction: t.TravelRuleAccessActionSchema,
  CctpTransferStatus: t.CctpTransferStatusSchema,
  DisputeEvidenceRole: t.DisputeEvidenceRoleSchema,
  ArbitrationEventType: t.ArbitrationEventTypeSchema,
};

const acceptsUndefined = (schema) => schema.safeParse(undefined).success;

for (const [name, schema] of Object.entries(OBJECTS)) {
  test(`${name}: zod ve OpenAPI alanları aynı`, () => {
    const oas = components[name];
    assert.ok(oas, `OpenAPI bileşeni yok: ${name}`);
    const zodKeys = Object.keys(schema.shape).sort();
    assert.deepEqual(Object.keys(oas.properties).sort(), zodKeys);
    const zodRequired = zodKeys.filter((k) => !acceptsUndefined(schema.shape[k]));
    assert.deepEqual([...(oas.required ?? [])].sort(), zodRequired);
  });
}

for (const [name, schema] of Object.entries(ENUMS)) {
  test(`${name}: enum değerleri aynı`, () => {
    assert.deepEqual([...components[name].enum].sort(), [...schema.options].sort());
  });
}

test('IDL şemaları: her hesap, event ve instruction için OpenAPI şeması var', () => {
  for (const program of Object.values(t.IDL_PROGRAMS)) {
    for (const name of [...program.accounts, ...program.events]) assert.ok(idlSchemas[name], name);
    for (const ix of program.instructions) {
      const pascal = ix
        .split('_')
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join('');
      assert.ok(idlSchemas[`${pascal}Args`], `${pascal}Args`);
    }
  }
});

test('ProgramErrorRef.program, IDL program adlarıyla aynı', () => {
  assert.deepEqual([...components.ProgramErrorRef.properties.program.enum].sort(), Object.keys(t.IDL_PROGRAMS).sort());
});

test('info.version, API_CONTRACT_VERSION ile aynı', () => {
  assert.equal(spec.info.version, t.API_CONTRACT_VERSION);
});

test('info.license, repo lisansıyla aynı', () => {
  assert.deepEqual(spec.info.license, { name: rootPackage.license, identifier: rootPackage.license });
});
