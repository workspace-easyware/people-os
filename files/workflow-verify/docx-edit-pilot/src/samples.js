// 시험 문서 2종.
//  makeLibDoc()      docx 9.16.0(People OS "새 Word 문서 만들기"가 쓰는 라이브러리)로 만든 문서
//  makeWordLikeDoc() Word가 저장한 파일의 모양을 손으로 흉내 낸 문서 — run이 쪼개진 문장(rsid·proofErr), 책갈피, 하이퍼링크,
//                    필드, 탭·줄바꿈, 변경 내용 추적(ins/del), 머리글·바닥글, 병합 셀, 메모가 들어 있다.
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, Header, Footer } from "docx";
import { zipSync, strToU8 } from "fflate";

export async function makeLibDoc() {
  const cell = (t, bold) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold: !!bold })] })] });
  const doc = new Document({
    creator: "People OS pilot",
    title: "코칭 프로그램 운영 보고서",
    sections: [{
      headers: { default: new Header({ children: [new Paragraph("일잇 People OS — 머리글")] }) },
      footers: { default: new Footer({ children: [new Paragraph("대외비 — 바닥글")] }) },
      children: [
        new Paragraph({ text: "코칭 프로그램 운영 보고서", heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun("2026년 상반기 코칭 세션은 총 "), new TextRun({ text: "24회", bold: true }), new TextRun(" 진행되었습니다.")] }),
        new Paragraph({ children: [new TextRun({ text: "담당 코치: ", italics: true }), new TextRun({ text: "김코치", color: "C00000", bold: true })] }),
        new Paragraph({ text: "세션 현황", heading: HeadingLevel.HEADING_2 }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          columnWidths: [3000, 3000, 3000],
          rows: [
            new TableRow({ children: [cell("코치", true), cell("주제", true), cell("세션 수", true)] }),
            new TableRow({ children: [cell("김코치"), cell("리더십"), cell("12")] }),
            new TableRow({ children: [cell("이코치"), cell("커리어"), cell("8")] }),
            new TableRow({ children: [cell("박코치"), cell("팀빌딩"), cell("4")] }),
          ],
        }),
        new Paragraph({ text: "다음 단계", heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: "하반기 일정 확정", bullet: { level: 0 } }),
        new Paragraph({ text: "코치 추가 선발", bullet: { level: 0 } }),
        new Paragraph("대조군 문단 — 이 문단은 편집하지 않는다. 김코치라는 이름이 여기에도 나온다."),
      ],
    }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const rpr = '<w:rPr><w:rFonts w:ascii="맑은 고딕" w:eastAsia="맑은 고딕" w:hAnsi="맑은 고딕" w:hint="eastAsia"/></w:rPr>';

export function wordLikeParts() {
  const document = `${XML}<w:document ${W_NS}><w:body>` +
    // 1) 제목 (스타일)
    `<w:p w14:paraId="1A000001" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr><w:t>분기 코칭 리뷰</w:t></w:r></w:p>` +
    // 2) run이 쪼개진 문장: "담당자는 홍길동 팀장입니다." — "홍길동"이 run 3개에 걸쳐 있다 (rsid·proofErr·서식 경계)
    `<w:p w14:paraId="1A000002" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00B22222"><w:r>${rpr}<w:t xml:space="preserve">담당자는 </w:t></w:r><w:proofErr w:type="spellStart"/><w:r w:rsidR="00C33333"><w:rPr><w:b/></w:rPr><w:t>홍</w:t></w:r><w:r w:rsidR="00D44444"><w:rPr><w:b/></w:rPr><w:t>길</w:t></w:r><w:proofErr w:type="spellEnd"/><w:r><w:rPr><w:b/><w:color w:val="C00000"/></w:rPr><w:t>동</w:t></w:r><w:r>${rpr}<w:t xml:space="preserve"> 팀장입니다.</w:t></w:r></w:p>` +
    // 3) 책갈피 + 하이퍼링크 + 탭 + 줄바꿈
    `<w:p w14:paraId="1A000003" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:bookmarkStart w:id="0" w:name="_GoBack"/><w:bookmarkEnd w:id="0"/><w:r><w:t xml:space="preserve">자세한 내용은 </w:t></w:r><w:hyperlink r:id="rId5" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>사내 위키</w:t></w:r></w:hyperlink><w:r><w:t>를 보세요.</w:t></w:r><w:r><w:tab/><w:t>(탭 뒤)</w:t></w:r><w:r><w:br/><w:t>줄바꿈 뒤 문장</w:t></w:r></w:p>` +
    // 4) 필드 (fldSimple DATE) — 필드 결과는 건드리지 않는다
    `<w:p w14:paraId="1A000004" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:r><w:t xml:space="preserve">작성일: </w:t></w:r><w:fldSimple w:instr=" DATE \\@ &quot;yyyy-MM-dd&quot; "><w:r><w:rPr><w:noProof/></w:rPr><w:t>2026-11-22</w:t></w:r></w:fldSimple></w:p>` +
    // 5) 변경 내용 추적: 삭제된 "3분기" + 삽입된 "4분기"
    `<w:p w14:paraId="1A000005" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:r><w:t xml:space="preserve">대상 기간은 </w:t></w:r><w:del w:id="10" w:author="검토자" w:date="2026-11-20T09:00:00Z"><w:r><w:delText>3분기</w:delText></w:r></w:del><w:ins w:id="11" w:author="검토자" w:date="2026-11-20T09:00:00Z"><w:r><w:t>4분기</w:t></w:r></w:ins><w:r><w:t>입니다.</w:t></w:r></w:p>` +
    // 6) 메모가 달린 문단
    `<w:p w14:paraId="1A000006" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:commentRangeStart w:id="1"/><w:r><w:t>예산은 500만 원입니다.</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r></w:p>` +
    // 7) 표: 헤더 + 2행, 마지막 행은 가로 병합(gridSpan 2), 셀 하나는 문단 2개
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="3005"/><w:gridCol w:w="3005"/><w:gridCol w:w="3006"/></w:tblGrid>` +
    `<w:tr w:rsidR="00A11111" w14:paraId="1B000001" w14:textId="77777777"><w:tc><w:tcPr><w:tcW w:w="3005" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr><w:p w14:paraId="1B000002" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>항목</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3005" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr><w:p w14:paraId="1B000003" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>목표</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3006" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr><w:p w14:paraId="1B000004" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>실적</w:t></w:r></w:p></w:tc></w:tr>` +
    `<w:tr w:rsidR="00A11111" w14:paraId="1B000005" w14:textId="77777777"><w:tc><w:tcPr><w:tcW w:w="3005" w:type="dxa"/></w:tcPr><w:p w14:paraId="1B000006" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:r><w:t>세션 수</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3005" w:type="dxa"/></w:tcPr><w:p w14:paraId="1B000007" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>30</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3006" w:type="dxa"/></w:tcPr><w:p w14:paraId="1B000008" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:color w:val="0070C0"/></w:rPr><w:t>2</w:t></w:r><w:r w:rsidR="00E55555"><w:rPr><w:color w:val="0070C0"/></w:rPr><w:t>4</w:t></w:r></w:p><w:p w14:paraId="1B000009" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:r><w:t>(잠정)</w:t></w:r></w:p></w:tc></w:tr>` +
    `<w:tr w:rsidR="00A11111" w14:paraId="1B00000A" w14:textId="77777777"><w:tc><w:tcPr><w:tcW w:w="3005" w:type="dxa"/></w:tcPr><w:p w14:paraId="1B00000B" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:r><w:t>비고</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="6011" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr><w:p w14:paraId="1B00000C" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:r><w:t>홍길동 팀장 확인 필요</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
    // 8) 대조군 + 빈 문단
    `<w:p w14:paraId="1A000007" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:spacing w:before="240" w:after="120"/><w:ind w:left="420"/></w:pPr><w:r><w:rPr><w:i/><w:sz w:val="20"/></w:rPr><w:t>대조군 문단 — 편집하지 않는다 &amp; 특수문자 &lt;꺾쇠&gt; "따옴표".</w:t></w:r></w:p>` +
    `<w:p w14:paraId="1A000008" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"/>` +
    `<w:sectPr w:rsidR="00A11111"><w:headerReference w:type="default" r:id="rId6"/><w:footerReference w:type="default" r:id="rId7"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="425"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`;

  const styles = `${XML}<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:kern w:val="2"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="ko-KR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="0"/><w:wordWrap w:val="0"/><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>` +
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4513"/><w:tab w:val="right" w:pos="9026"/></w:tabs><w:snapToGrid w:val="0"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4513"/><w:tab w:val="right" w:pos="9026"/></w:tabs><w:snapToGrid w:val="0"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/></w:style></w:styles>`;

  const header = `${XML}<w:hdr ${W_NS}><w:p w14:paraId="1C000001" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:t>일잇 People OS — 머리글 (홍길동)</w:t></w:r></w:p></w:hdr>`;
  const footer = `${XML}<w:ftr ${W_NS}><w:p w14:paraId="1D000001" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:noProof/></w:rPr><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  const comments = `${XML}<w:comments ${W_NS}><w:comment w:id="1" w:author="검토자" w:date="2026-11-20T09:10:00Z" w:initials="검"><w:p w14:paraId="1E000001" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:pPr><w:pStyle w:val="CommentText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r><w:r><w:t>예산 근거를 확인해 주세요.</w:t></w:r></w:p></w:comment></w:comments>`;
  const settings = `${XML}<w:settings ${W_NS}><w:zoom w:percent="100"/><w:bordersDoNotSurroundHeader/><w:bordersDoNotSurroundFooter/><w:defaultTabStop w:val="800"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:useFELayout/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><w:rsids><w:rsidRoot w:val="00A11111"/><w:rsid w:val="00A11111"/><w:rsid w:val="00B22222"/><w:rsid w:val="00C33333"/><w:rsid w:val="00D44444"/><w:rsid w:val="00E55555"/></w:rsids><w:themeFontLang w:val="en-US" w:eastAsia="ko-KR"/><w:decimalSymbol w:val="."/><w:listSeparator w:val=","/></w:settings>`;
  const fontTable = `${XML}<w:fonts ${W_NS}><w:font w:name="맑은 고딕"><w:panose1 w:val="020B0503020000020004"/><w:charset w:val="81"/><w:family w:val="modern"/><w:pitch w:val="variable"/><w:sig w:usb0="9000002F" w:usb1="29D77CFB" w:usb2="00000012" w:usb3="00000000" w:csb0="00080001" w:csb1="00000000"/></w:font><w:font w:name="Times New Roman"><w:panose1 w:val="02020603050405020304"/><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/><w:sig w:usb0="E0002EFF" w:usb1="C000785B" w:usb2="00000009" w:usb3="00000000" w:csb0="000001FF" w:csb1="00000000"/></w:font></w:fonts>`;
  const rels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://wiki.example.com/coaching" TargetMode="External"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`;
  const rootRels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const ct = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const core = `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>분기 코칭 리뷰</dc:title><dc:creator>홍길동</dc:creator><cp:lastModifiedBy>홍길동</cp:lastModifiedBy><cp:revision>2</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-11-20T08:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-11-20T09:30:00Z</dcterms:modified></cp:coreProperties>`;
  const app = `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>Normal.dotm</Template><TotalTime>3</TotalTime><Pages>1</Pages><Words>40</Words><Characters>200</Characters><Application>Microsoft Office Word</Application><DocSecurity>0</DocSecurity><Lines>1</Lines><Paragraphs>1</Paragraphs><ScaleCrop>false</ScaleCrop><Company></Company><LinksUpToDate>false</LinksUpToDate><CharactersWithSpaces>230</CharactersWithSpaces><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>`;
  return {
    "[Content_Types].xml": ct,
    "_rels/.rels": rootRels,
    "word/document.xml": document,
    "word/_rels/document.xml.rels": rels,
    "word/styles.xml": styles,
    "word/settings.xml": settings,
    "word/fontTable.xml": fontTable,
    "word/comments.xml": comments,
    "word/header1.xml": header,
    "word/footer1.xml": footer,
    "docProps/core.xml": core,
    "docProps/app.xml": app,
  };
}

export function makeWordLikeDoc() {
  const parts = wordLikeParts();
  const files = {};
  for (const [k, v] of Object.entries(parts)) files[k] = strToU8(v);
  return zipSync(files, { level: 6, mtime: new Date("2026-11-20T09:30:00Z") });
}

/** 큰 문서 (CPU 측정용): 문단 n개 + 표 (n/50)개. */
export function makeBigDoc(n) {
  const parts = wordLikeParts();
  const body = [];
  for (let i = 1; i <= n; i++) {
    body.push(`<w:p w14:paraId="${(0x2a000000 + i).toString(16).toUpperCase()}" w14:textId="77777777" w:rsidR="00A11111" w:rsidRDefault="00A11111"><w:r><w:t xml:space="preserve">문단 ${i}: 코칭 세션 기록입니다. 담당자는 </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>홍길동</w:t></w:r><w:r><w:t xml:space="preserve"> 팀장이며 이 문장은 길이를 채우기 위한 내용입니다.</w:t></w:r></w:p>`);
    if (i % 50 === 0) {
      body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4508"/><w:gridCol w:w="4508"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4508" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>구간 ${i}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4508" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${i * 3}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`);
    }
  }
  parts["word/document.xml"] = `${XML}<w:document ${W_NS}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  parts["word/_rels/document.xml.rels"] = parts["word/_rels/document.xml.rels"].replace(/<Relationship Id="rId[4567]"[^>]*\/>/g, "");
  parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(/<Override PartName="\/word\/(comments|header1|footer1)\.xml"[^>]*\/>/g, "");
  delete parts["word/comments.xml"];
  delete parts["word/header1.xml"];
  delete parts["word/footer1.xml"];
  const files = {};
  for (const [k, v] of Object.entries(parts)) files[k] = strToU8(v);
  return zipSync(files, { level: 6, mtime: new Date("2026-11-20T09:30:00Z") });
}
