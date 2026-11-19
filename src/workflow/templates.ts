// 워크플로우 기업용 템플릿 5개 (2026-11-19). 코드 내장 — D1 마이그레이션 없음, 새 노드 타입 없음 (기존 노드 15종만 사용).
// GET /api/workflows/templates 로 내려가고, 프런트가 "이 템플릿으로 만들기"를 누르면 definition을 그대로 POST /api/workflows 에 보낸다
// (검증은 기존 validateDefinition). 만든 뒤에는 일반 워크플로우와 같아서 단계 설정을 자유롭게 바꿀 수 있다.
//
// "폼 입력"은 실행 입력({{input.x}})으로 표현한다: 노드 15종에 폼 노드가 없으므로, 템플릿의 inputs(항목·설명·예시)를
// 카드와 실행 화면의 고급 입력(JSON)에 미리 채워 준다. 사용자는 예시 값만 바꿔 실행하면 된다.
import type { WorkflowStepDef } from "./types";

export interface TemplateInput { key: string; label: string; example: string; }
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** 카드에 표시: 이 템플릿을 실행할 때 넣는 값 (실행 입력 JSON의 키). */
  inputs: TemplateInput[];
  steps: WorkflowStepDef[];
}

// 시각 예시는 UTC ISO(YYYY-MM-DDTHH:MM:SSZ) — create_calendar_event 노드의 형식. KST 09:00 = 전날 00:00Z, 종일 = KST 자정 = 15:00:00Z.
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "meeting-automation",
    name: "회의 자동화",
    description: "회의 녹음 전사본을 요약하고, 할 일을 만들고, 참석자에게 보낼 메일 초안까지 한 번에 만듭니다. 전사가 끝난 문서 ID를 넣고 실행하세요.",
    inputs: [
      { key: "docId", label: "전사가 끝난 회의 문서 ID", example: "doc_회의문서ID" },
      { key: "attendees", label: "메일 초안 받는 사람", example: "team@example.com" },
    ],
    steps: [
      { id: "s1", type: "transcribe", name: "회의 전사 가져오기", config: { docId: "{{input.docId}}" } },
      { id: "s2", type: "summarize", name: "회의 요약·액션 아이템", config: { docId: "{{steps.s1.output.docId}}" } },
      { id: "s3", type: "create_task", name: "후속 할 일 만들기", config: { title: "회의 후속 조치: {{steps.s2.output.actions}}" } },
      { id: "s4", type: "email_draft", name: "회의록 메일 초안", config: { to: "{{input.attendees}}", context: "방금 끝난 회의의 요약과 후속 조치를 참석자에게 공유하는 메일.\n요약: {{steps.s2.output.summary}}\n후속 조치: {{steps.s2.output.actions}}" } },
    ],
  },
  {
    id: "leave-approval",
    name: "휴가 신청 승인",
    description: "휴가 종류·기간·사유를 입력하면 결재자에게 승인 요청 메일이 나가고, 승인되면 내 캘린더에 휴가 일정이 등록됩니다.",
    inputs: [
      { key: "approver", label: "결재자 메일", example: "manager@example.com" },
      { key: "leaveType", label: "휴가 종류", example: "연차" },
      { key: "period", label: "기간 (표시용)", example: "2026-12-24 ~ 2026-12-26" },
      { key: "reason", label: "사유", example: "가족 여행" },
      { key: "start", label: "휴가 시작 (UTC, KST 자정=15:00:00Z)", example: "2026-12-23T15:00:00Z" },
      { key: "end", label: "휴가 끝 (UTC, 마지막 날 다음 날 KST 자정)", example: "2026-12-26T15:00:00Z" },
    ],
    steps: [
      { id: "s1", type: "send_email", name: "결재자에게 승인 요청 메일", requiresApproval: true, config: { to: "{{input.approver}}", subject: "[휴가 신청] {{input.leaveType}} ({{input.period}})", body: "휴가를 신청합니다.\n\n- 종류: {{input.leaveType}}\n- 기간: {{input.period}}\n- 사유: {{input.reason}}\n\n검토 후 회신 부탁드립니다." } },
      { id: "s2", type: "create_calendar_event", name: "휴가 일정 등록", config: { title: "휴가 ({{input.leaveType}})", start: "{{input.start}}", end: "{{input.end}}", allDay: true } },
    ],
  },
  {
    id: "weekly-report",
    name: "주간 보고 자동 작성",
    description: "내 문서에서 이번 주 할 일·완료 항목을 모으고, LLM으로 주간 보고 초안을 쓴 뒤, 팀장에게 보낼 메일 초안으로 만듭니다.",
    inputs: [{ key: "manager", label: "보고 받는 사람", example: "manager@example.com" }],
    steps: [
      { id: "s1", type: "ask_personal", name: "이번 주 할 일·완료 항목 수집", config: { question: "이번 주에 내가 한 일, 진행 중인 일, 다음 주 할 일을 내 문서에서 찾아 항목별로 정리해 줘." } },
      { id: "s2", type: "llm", name: "주간 보고 초안 작성", config: { prompt: "아래 내용으로 한국어 주간 보고를 써줘. 형식: 1) 이번 주 완료 2) 진행 중 3) 다음 주 계획 4) 이슈·요청. 없는 사실은 지어내지 말고 모르면 [확인 필요]로 표시.\n\n{{steps.s1.output.answer}}" } },
      { id: "s3", type: "email_draft", name: "주간 보고 메일 초안", config: { to: "{{input.manager}}", context: "주간 보고를 보내는 메일. 본문은 아래 보고 내용을 담는다.\n\n{{steps.s2.output.text}}" } },
    ],
  },
  {
    id: "new-hire-onboarding",
    name: "신입 온보딩",
    description: "신입 입사 첫 주에 필요한 온보딩 체크리스트를 할 일로 만들고, 오리엔테이션·멘토링 일정을 캘린더에 등록합니다.",
    inputs: [
      { key: "newHire", label: "신입 이름", example: "김하늘" },
      { key: "orientationStart", label: "오리엔테이션 시작 (UTC)", example: "2026-12-01T00:00:00Z" },
      { key: "orientationEnd", label: "오리엔테이션 끝 (UTC)", example: "2026-12-01T03:00:00Z" },
      { key: "mentoringStart", label: "멘토링 시작 (UTC)", example: "2026-12-02T05:00:00Z" },
      { key: "mentoringEnd", label: "멘토링 끝 (UTC)", example: "2026-12-02T06:00:00Z" },
    ],
    steps: [
      { id: "s1", type: "create_task", name: "계정·장비 준비", config: { title: "[온보딩] {{input.newHire}} 계정(메일·메신저)·장비 준비" } },
      { id: "s2", type: "create_task", name: "인사 서류 수령", config: { title: "[온보딩] {{input.newHire}} 근로계약·인사 서류 수령" } },
      { id: "s3", type: "create_task", name: "회사 규정·보안 교육 안내", config: { title: "[온보딩] {{input.newHire}} 회사 규정·정보보안 교육 이수 안내" } },
      { id: "s4", type: "create_task", name: "30일 목표 합의", config: { title: "[온보딩] {{input.newHire}} 첫 30일 목표 합의" } },
      { id: "s5", type: "create_calendar_event", name: "오리엔테이션 일정", config: { title: "신입 오리엔테이션 ({{input.newHire}})", start: "{{input.orientationStart}}", end: "{{input.orientationEnd}}" } },
      { id: "s6", type: "create_calendar_event", name: "멘토링 일정", config: { title: "멘토링 첫 만남 ({{input.newHire}})", start: "{{input.mentoringStart}}", end: "{{input.mentoringEnd}}" } },
    ],
  },
  {
    id: "expense-approval",
    name: "지출 결재 요청",
    description: "지출 항목·금액·증빙을 입력하면 결재자에게 결재 요청 메일이 나가고(승인 필요), 이후 결과를 확인하라는 알림용 할 일이 만들어집니다.",
    inputs: [
      { key: "approver", label: "결재자 메일", example: "finance@example.com" },
      { key: "item", label: "지출 항목", example: "팀 워크숍 장소 대관" },
      { key: "amount", label: "금액", example: "350,000원" },
      { key: "receipt", label: "증빙 (링크·문서 ID)", example: "영수증 사본 첨부 예정" },
    ],
    steps: [
      { id: "s1", type: "send_email", name: "결재자에게 결재 요청 메일", requiresApproval: true, config: { to: "{{input.approver}}", subject: "[지출 결재 요청] {{input.item}} {{input.amount}}", body: "지출 결재를 요청합니다.\n\n- 항목: {{input.item}}\n- 금액: {{input.amount}}\n- 증빙: {{input.receipt}}\n\n검토 후 승인 부탁드립니다." } },
      { id: "s2", type: "create_task", name: "결재 결과 확인 알림", config: { title: "결재 결과 확인: {{input.item}} {{input.amount}}" } },
    ],
  },
];
