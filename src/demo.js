// ============================================================
// デモ用の見本データ
// 「🌱 デモで試してみる」を押した人ごとに、この内容で庭を1つ作る。
// 会社名・求人票はすべて架空のもの。
// ============================================================

// 「今から◯日前」の日時を、D1のCURRENT_TIMESTAMPと同じ形式（"2026-09-30 12:34:56"）で作る
function daysAgo(days, hours = 0) {
	const ms = Date.now() - (days * 24 + hours) * 60 * 60 * 1000;
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

// 希望条件（並び順どおり）
const DEMO_CONDITIONS = ["リモート勤務あり", "自社開発", "フロントエンド中心", "年間休日120日以上"];

// 企業ごとの見本データ
// records の category は成長段階の判定に使われる（job_text / impression / honne / memo の種類数で段階が決まる）
const DEMO_COMPANIES = [
	{
		// 4種類そろっている → 花
		company_name: "株式会社アオバ",
		status: "一次面接",
		interest_level: 5,
		is_favorite: 1,
		is_sleeping: 0,
		short_memo: "雰囲気が好き",
		created_at: daysAgo(12),
		selection_flow: "書類選考 → 一次面接 → 最終面接 → 内定",
		job_text: `【募集職種】フロントエンドエンジニア
【仕事内容】自社で運営する家計簿アプリ「アオバノート」のWebフロントエンド開発。React / TypeScriptを使用し、デザイナー・バックエンドエンジニアとチームで開発します。
【働き方】週3日までリモート勤務可
【休日】土日祝休み、夏季・年末年始休暇
【選考フロー】書類選考 → 一次面接 → 最終面接 → 内定`,
		impressions: [
			{ type: "good", content: "自社サービスを育てている" },
			{ type: "good", content: "コードレビューの文化がある" },
			{ type: "concern", content: "残業時間の実態が分からない" },
		],
		honne: "正直ここが一番行きたい。ただ、面接で技術の話についていけるか少し不安。",
		memos: ["チームの人数と構成は？", "入社後の研修の流れ"],
		matches: [
			{ mark: "yes", note: "週3日までリモート可" },
			{ mark: "yes", note: "自社アプリを開発" },
			{ mark: "yes", note: "React / TypeScript" },
			{ mark: "mid", note: "日数の記載なし" },
		],
		suggestions: ["年間休日は何日ありますか？", "リモートの曜日は選べますか？"],
		records: [
			{ category: "job_text", title: "植えた日", note: "", at: daysAgo(12) },
			{ category: "impression", title: "いいなを2件追加", note: "自社サービスを育てている、コードレビ…", at: daysAgo(12, -1) },
			{ category: "rematch", title: "AIが希望条件と照合", note: "", at: daysAgo(11) },
			{ category: "status", title: "書類選考", note: "", at: daysAgo(10) },
			{ category: "honne", title: "本音を記録", note: "", at: daysAgo(9) },
			{ category: "memo", title: "メモを追加", note: "チームの人数と構成は？", at: daysAgo(8) },
			{ category: "status", title: "一次面接", note: "", at: daysAgo(2) },
		],
	},
	{
		// 3種類 → つぼみ（最後の記録が8日前なので、記録タブの「しばらく記録がありません」にも出る）
		company_name: "株式会社ミナト",
		status: "書類選考",
		interest_level: 4,
		is_favorite: 0,
		is_sleeping: 0,
		short_memo: "福利厚生が◎",
		created_at: daysAgo(15),
		selection_flow: "書類選考 → 面接（2回） → 内定",
		job_text: `【募集職種】Webエンジニア（フロントエンド寄り）
【仕事内容】受託開発と自社サービスの両方に携わります。Vue.js / Nuxtを使った画面開発が中心です。
【働き方】リモート勤務可（月に数回、出社日あり）
【休日】年間休日125日、完全週休2日制
【福利厚生】書籍購入補助、資格取得支援
【選考フロー】書類選考 → 面接（2回） → 内定`,
		impressions: [
			{ type: "good", content: "福利厚生が充実している" },
			{ type: "concern", content: "受託案件の割合が高そう" },
		],
		honne: "条件はすごくいいけど、仕事内容にまだピンときていない。",
		memos: [],
		matches: [
			{ mark: "mid", note: "月数回の出社あり" },
			{ mark: "mid", note: "受託と自社の両方" },
			{ mark: "yes", note: "Vue.js / Nuxt" },
			{ mark: "yes", note: "年間休日125日" },
		],
		suggestions: ["受託と自社の比率は？", "出社日の頻度を確認したい"],
		records: [
			{ category: "job_text", title: "植えた日", note: "", at: daysAgo(15) },
			{ category: "impression", title: "いいなを追加", note: "福利厚生が充実している", at: daysAgo(15, -1) },
			{ category: "rematch", title: "AIが希望条件と照合", note: "", at: daysAgo(14) },
			{ category: "honne", title: "本音を記録", note: "", at: daysAgo(8, 2) },
			{ category: "status", title: "書類選考", note: "", at: daysAgo(8) },
		],
	},
	{
		// 2種類 → 双葉
		company_name: "合同会社ソラ",
		status: "応募前",
		interest_level: 3,
		is_favorite: 1,
		is_sleeping: 0,
		short_memo: null,
		created_at: daysAgo(5),
		selection_flow: "カジュアル面談 → 面接 → 内定",
		job_text: `【募集職種】Webアプリケーションエンジニア
【仕事内容】少人数チームで、自社の予約管理アプリをフロントからバックエンドまで幅広く担当します。
【働き方】フルリモート可
【選考フロー】カジュアル面談 → 面接 → 内定`,
		impressions: [{ type: "good", content: "少人数で裁量が大きい" }],
		honne: null,
		memos: [],
		matches: [
			{ mark: "yes", note: "フルリモート可" },
			{ mark: "yes", note: "自社アプリを開発" },
			{ mark: "mid", note: "フルスタック寄り" },
			{ mark: "no", note: "記載なし" },
		],
		suggestions: ["休日の日数を確認したい", "フロントの比重はどのくらい？"],
		records: [
			{ category: "job_text", title: "植えた日", note: "", at: daysAgo(5) },
			{ category: "rematch", title: "AIが希望条件と照合", note: "", at: daysAgo(5, -1) },
			{ category: "impression", title: "いいなを追加", note: "少人数で裁量が大きい", at: daysAgo(4) },
		],
	},
	{
		// 1種類 → たね（まだ照合していないので、デモの人がAI照合を試せる）
		company_name: "株式会社ヒカリ",
		status: "応募前",
		interest_level: 2,
		is_favorite: 0,
		is_sleeping: 0,
		short_memo: null,
		created_at: daysAgo(1),
		selection_flow: null,
		job_text: `【募集職種】フロントエンドエンジニア（未経験歓迎）
【仕事内容】自社で開発・運営している学習アプリの画面開発を担当します。React / Next.jsを使用。先輩エンジニアによるメンター制度あり。
【働き方】原則出社（入社3か月後から週1日リモート可）
【休日】年間休日122日、土日祝休み
【選考フロー】書類選考 → 技術課題 → 面接 → 内定`,
		impressions: [],
		honne: null,
		memos: [],
		matches: [],
		suggestions: [],
		records: [{ category: "job_text", title: "植えた日", note: "", at: daysAgo(1) }],
	},
	{
		// 眠らせた企業（記録タブの「眠っている」に出る）
		company_name: "株式会社フユ",
		status: "見送り",
		interest_level: 2,
		is_favorite: 0,
		is_sleeping: 1,
		short_memo: null,
		created_at: daysAgo(20),
		selection_flow: "書類選考 → 面接 → 内定",
		job_text: `【募集職種】システムエンジニア
【仕事内容】業務システムの受託開発。
【働き方】客先常駐あり
【選考フロー】書類選考 → 面接 → 内定`,
		impressions: [],
		honne: null,
		memos: [],
		matches: [],
		suggestions: [],
		records: [
			{ category: "job_text", title: "植えた日", note: "", at: daysAgo(20) },
			{ category: "status", title: "見送り", note: "", at: daysAgo(13) },
		],
	},
];

// 指定したユーザーの庭に、見本データを入れる
export async function seedDemoData(env, userId) {
	// 1. 希望条件を登録して、そのidを控えておく（照合結果と結びつけるため）
	const conditionIds = [];
	for (let i = 0; i < DEMO_CONDITIONS.length; i++) {
		const result = await env.DB.prepare(
			"INSERT INTO desired_conditions (user_id, label, sort_order) VALUES (?, ?, ?)"
		).bind(userId, DEMO_CONDITIONS[i], i).run();
		conditionIds.push(result.meta.last_row_id);
	}

	// 2. 企業ごとに、企業本体 → 紐づくデータ の順で登録する
	for (const c of DEMO_COMPANIES) {
		const result = await env.DB.prepare(
			`INSERT INTO companies
			 (user_id, company_name, job_text, interest_level, status, is_favorite, is_sleeping,
			  short_memo, selection_flow, selection_flow_manually_edited, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
		).bind(
			userId, c.company_name, c.job_text, c.interest_level, c.status,
			c.is_favorite, c.is_sleeping, c.short_memo, c.selection_flow, c.created_at
		).run();
		const companyId = result.meta.last_row_id;

		// 紐づくデータは、まとめて1回で書き込む（batch）
		const statements = [];

		for (const imp of c.impressions) {
			statements.push(
				env.DB.prepare("INSERT INTO impressions (company_id, type, content, created_at) VALUES (?, ?, ?, ?)")
					.bind(companyId, imp.type, imp.content, c.created_at)
			);
		}
		if (c.honne) {
			statements.push(
				env.DB.prepare("INSERT INTO honne (company_id, content) VALUES (?, ?)").bind(companyId, c.honne)
			);
		}
		for (const memo of c.memos) {
			statements.push(
				env.DB.prepare("INSERT INTO memos (company_id, content, created_at) VALUES (?, ?, ?)")
					.bind(companyId, memo, c.created_at)
			);
		}
		c.matches.forEach((m, i) => {
			statements.push(
				env.DB.prepare(
					"INSERT INTO requirement_matches (company_id, condition_id, mark, note, manually_edited) VALUES (?, ?, ?, ?, 0)"
				).bind(companyId, conditionIds[i], m.mark, m.note)
			);
		});
		for (const s of c.suggestions) {
			statements.push(
				env.DB.prepare("INSERT INTO ai_suggestions (company_id, content) VALUES (?, ?)").bind(companyId, s)
			);
		}
		for (const r of c.records) {
			statements.push(
				env.DB.prepare("INSERT INTO records (company_id, category, title, note, created_at) VALUES (?, ?, ?, ?, ?)")
					.bind(companyId, r.category, r.title, r.note, r.at)
			);
		}

		if (statements.length > 0) {
			await env.DB.batch(statements);
		}
	}
}