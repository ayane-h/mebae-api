export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// フロントエンド（別のポート）からのアクセスを許可する設定
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		};

		// ブラウザが本番リクエストの前に送る確認リクエストへの応答
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		// 記録を1件書き込むための共通処理
		// title: タイムラインに太字で出す短いタイトル（例:"メモを追加"）
		// detail: 日付の後ろに添える補足（例:"給与について"）。無ければ空文字でOK
		async function addRecord(env, companyId, category, title, detail = "") {
			await env.DB.prepare(
				"INSERT INTO records (company_id, category, title, note) VALUES (?, ?, ?, ?)"
			).bind(companyId, category, title, detail).run();
		}

		// いいな・気になる、メモなどの本文が長い場合に、タイムライン表示用に短く切り詰める
		function truncate(text, maxLength = 20) {
			if (!text) return "";
			return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
		}

		// 「成長判定に使うカテゴリ」だけをバケット名に変換する対応表
		// status と rematch はここに含めない = 成長には影響しない
		const GROWTH_BUCKETS = {
			job_text: "knowing",       // ① 求人を知る
			impression: "compatibility", // ② 自分との相性を考える
			honne: "feelings",          // ③ 気持ちを言葉にする
			memo: "questions",          // ④ 疑問・確認事項を整理する
		};

		// categoryの配列（例: ["job_text","impression","impression","honne"]）を受け取って、
		// 何種類のバケットが埋まっているかを数え、段階を返す
		function calcGrowthStage(categories) {
			const buckets = new Set(); // Setは「重複を自動で無視してくれる箱」
			for (const cat of categories) {
				if (GROWTH_BUCKETS[cat]) {
					buckets.add(GROWTH_BUCKETS[cat]);
				}
			}
			const count = buckets.size; // 箱の中に何種類入っているか
			if (count >= 4) return "flower";
			if (count === 3) return "bud";
			if (count === 2) return "sprout";
			return "seed";
		}

		// GET /companies : 企業一覧の取得（各企業に成長段階 growth_stage を付けて返す）
		if (request.method === "GET" && url.pathname === "/companies") {
			const { results: companies } = await env.DB.prepare(
				"SELECT * FROM companies ORDER BY created_at DESC"
			).all();

			// 全企業分のrecordsを一度に取得（企業ごとにクエリを投げると遅くなるため、まとめて取る）
			const { results: allRecords } = await env.DB.prepare(
				"SELECT company_id, category FROM records"
			).all();

			// company_idごとに、カテゴリの配列をまとめる
			const categoriesByCompany = {};
			for (const r of allRecords) {
				if (!categoriesByCompany[r.company_id]) categoriesByCompany[r.company_id] = [];
				categoriesByCompany[r.company_id].push(r.category);
			}

			// 各企業オブジェクトに growth_stage というフィールドを追加する
			const companiesWithStage = companies.map((c) => ({
				...c,
				growth_stage: calcGrowthStage(categoriesByCompany[c.id] || []),
			}));

			return Response.json(companiesWithStage, { headers: corsHeaders });
		}

		// POST /companies : 企業の新規登録
		if (request.method === "POST" && url.pathname === "/companies") {
			const body = await request.json();
			const { company_name, job_url, job_text, interest_level } = body;

			// 開発初期のため user_id は固定（ダミー）
			const userId = "dummy_user_123";

			const result = await env.DB.prepare(
				`INSERT INTO companies (user_id, company_name, job_url, job_text, interest_level)
				VALUES (?, ?, ?, ?, ?)`
			).bind(userId, company_name, job_url || null, job_text || null, interest_level || 3).run();

			const newCompanyId = result.meta.last_row_id; // 今作った企業のid

			// 求人票の本文があるかどうかで、記録のカテゴリを変える
			// （job_text: 成長判定に使う／company_registered: 記録には残すが成長には使わない）
			if (job_text) {
				await addRecord(env, newCompanyId, "job_text", "植えた日");
			} else {
				await addRecord(env, newCompanyId, "company_registered", "植えた日");
			}

			return Response.json(
				{ message: "Company added successfully!", id: newCompanyId },
				{ status: 201, headers: corsHeaders }
			);
		}

		// PATCH /companies/:id : 志望度・ステータスなどの更新
		if (request.method === "PATCH" && url.pathname.startsWith("/companies/")) {
			const id = url.pathname.split("/")[2];
			const body = await request.json();

			const fields = [];
			const values = [];

			if (body.interest_level !== undefined) {
				fields.push("interest_level = ?");
				values.push(body.interest_level);
			}
			if (body.status !== undefined) {
				fields.push("status = ?");
				values.push(body.status);
			}

			values.push(id);

			await env.DB.prepare(
				`UPDATE companies SET ${fields.join(", ")} WHERE id = ?`
			).bind(...values).run();

			// ステータスが変わった時だけ記録する（志望度の星だけの変更では記録しない）
			// タイトルにステータス名そのものを使う（例:"一次面接"）
			if (body.status !== undefined) {
				await addRecord(env, id, "status", body.status);
			}

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// GET /impressions?company_id=1 : 特定の企業のいいな・気になるを取得
		if (request.method === "GET" && url.pathname === "/impressions") {
			const companyId = url.searchParams.get("company_id");
			const { results } = await env.DB.prepare(
				"SELECT * FROM impressions WHERE company_id = ? ORDER BY created_at DESC"
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /impressions : いいな・気になるを追加
		if (request.method === "POST" && url.pathname === "/impressions") {
			const body = await request.json();
			const { company_id, type, content } = body;

			await env.DB.prepare(
				"INSERT INTO impressions (company_id, type, content) VALUES (?, ?, ?)"
			).bind(company_id, type, content).run();

			const title = type === "good" ? "いいなを追加" : "気になる点を追加";
			await addRecord(env, company_id, "impression", title, truncate(content));

			return Response.json({ success: true }, { status: 201, headers: corsHeaders });
		}

		// DELETE /impressions/:id : いいな・気になるを削除
		if (request.method === "DELETE" && url.pathname.startsWith("/impressions/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare("DELETE FROM impressions WHERE id = ?").bind(id).run();
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// POST /impressions/batch : 複数の「いいな・気になる」を一度に追加する
		// （＋植える画面のチップ選択のように、1回の操作でまとめて登録したい場合に使う。
		//  記録(records)は1件ずつではなく、全体で1件だけ作る）
		if (request.method === "POST" && url.pathname === "/impressions/batch") {
			const body = await request.json();
			const { company_id, contents } = body; // contents は文字列の配列

			if (!contents || contents.length === 0) {
				return Response.json({ success: true, count: 0 }, { headers: corsHeaders });
			}

			for (const content of contents) {
				await env.DB.prepare(
					"INSERT INTO impressions (company_id, type, content) VALUES (?, ?, ?)"
				).bind(company_id, "good", content).run();
			}

			// 記録は1つにまとめる（例:「いいなを3件追加」・内容を「、」で連結）
			const title = contents.length === 1 ? "いいなを追加" : `いいなを${contents.length}件追加`;
			await addRecord(env, company_id, "impression", title, truncate(contents.join("、"), 40));

			return Response.json({ success: true, count: contents.length }, { status: 201, headers: corsHeaders });
		}

		// GET /honne?company_id=1 : 本音を取得
		if (request.method === "GET" && url.pathname === "/honne") {
			const companyId = url.searchParams.get("company_id");
			const { results } = await env.DB.prepare(
				"SELECT * FROM honne WHERE company_id = ?"
			).bind(companyId).all();
			return Response.json(results[0] || null, { headers: corsHeaders });
		}

		// PUT /honne : 本音を保存（新規作成 or 上書き更新）
		if (request.method === "PUT" && url.pathname === "/honne") {
			const body = await request.json();
			const { company_id, content } = body;

			await env.DB.prepare(
				`INSERT INTO honne (company_id, content) VALUES (?, ?)
    ON CONFLICT(company_id) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP`
			).bind(company_id, content).run();

			await addRecord(env, company_id, "honne", "本音を記録");

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// GET /memos?company_id=1 : 特定の企業のメモを取得
		if (request.method === "GET" && url.pathname === "/memos") {
			const companyId = url.searchParams.get("company_id");
			const { results } = await env.DB.prepare(
				"SELECT * FROM memos WHERE company_id = ? ORDER BY created_at DESC"
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /memos : メモを追加
		if (request.method === "POST" && url.pathname === "/memos") {
			const body = await request.json();
			const { company_id, content } = body;

			await env.DB.prepare(
				"INSERT INTO memos (company_id, content) VALUES (?, ?)"
			).bind(company_id, content).run();

			await addRecord(env, company_id, "memo", "メモを追加", truncate(content));

			return Response.json({ success: true }, { status: 201, headers: corsHeaders });
		}

		// DELETE /memos/:id : メモを削除
		if (request.method === "DELETE" && url.pathname.startsWith("/memos/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare("DELETE FROM memos WHERE id = ?").bind(id).run();
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// GET /desired-conditions : 希望条件の一覧を取得
		if (request.method === "GET" && url.pathname === "/desired-conditions") {
			const { results } = await env.DB.prepare(
				"SELECT * FROM desired_conditions ORDER BY created_at ASC"
			).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /desired-conditions : 希望条件を1件追加（例: "リモート勤務"）
		if (request.method === "POST" && url.pathname === "/desired-conditions") {
			const body = await request.json();
			const { label } = body;
			const userId = "dummy_user_123"; // companiesと同じく仮のユーザーID

			await env.DB.prepare(
				"INSERT INTO desired_conditions (user_id, label) VALUES (?, ?)"
			).bind(userId, label).run();

			return Response.json({ message: "Condition added successfully!" }, { status: 201, headers: corsHeaders });
		}

		// ---- Geminiを呼び出す共通処理 ----
		// promptで質問を投げて、返ってきたJSONをそのままオブジェクトとして受け取る
		async function callGemini(prompt, apiKey) {
			const response = await fetch(
				"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-goog-api-key": apiKey,
					},
					body: JSON.stringify({
						contents: [{ parts: [{ text: prompt }] }],
						generationConfig: {
							responseMimeType: "application/json", // JSON形式だけを返してもらう指定
						},
					}),
				}
			);

			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`Gemini API error: ${response.status} ${errText}`);
			}

			const data = await response.json();
			const text = data.candidates[0].content.parts[0].text;
			return JSON.parse(text); // 文字列のJSONを、扱いやすいオブジェクトに変換
		}

		// GET /requirement-matches?company_id=1 : 照合結果の一覧を取得
		if (request.method === "GET" && url.pathname === "/requirement-matches") {
			const companyId = url.searchParams.get("company_id");
			// requirement_matches と desired_conditions を「条件の名前」で結びつけて取得する
			const { results } = await env.DB.prepare(
				`SELECT rm.id, rm.mark, rm.note, dc.id AS condition_id, dc.label
		 FROM requirement_matches rm
		 JOIN desired_conditions dc ON rm.condition_id = dc.id
		 WHERE rm.company_id = ?`
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /requirement-matches/rematch : 求人票と希望条件をAIに照らし合わせてもらう
		if (request.method === "POST" && url.pathname === "/requirement-matches/rematch") {
			const body = await request.json();
			const { company_id } = body;

			// 1. 対象企業の求人票本文を取得
			const company = await env.DB.prepare(
				"SELECT job_text FROM companies WHERE id = ?"
			).bind(company_id).first();

			if (!company || !company.job_text) {
				return Response.json(
					{ error: "求人票の本文が登録されていません" },
					{ status: 400, headers: corsHeaders }
				);
			}

			// 2. あなたの希望条件リストを取得
			const { results: conditions } = await env.DB.prepare(
				"SELECT id, label FROM desired_conditions ORDER BY created_at ASC"
			).all();

			if (conditions.length === 0) {
				return Response.json(
					{ error: "希望条件が1件も登録されていません" },
					{ status: 400, headers: corsHeaders }
				);
			}

			// 3. Geminiに渡す質問文（プロンプト）を組み立てる
			const conditionLabels = conditions.map((c) => c.label).join("、");
			const prompt = `
あなたは転職活動中の求人票を読んで、希望条件と照らし合わせるアシスタントです。
以下の求人票の文章を読み、各希望条件について求人票に記載があるかを判定してください。

# 求人票
${company.job_text}

# 希望条件（${conditions.length}件）
${conditionLabels}

# 出力形式
次の形式のJSON配列だけを出力してください（説明文は不要です）。
[
  { "label": "条件名", "mark": "yes" または "mid" または "no", "note": "根拠となる一言（15文字程度）" }
]

判定基準:
- "yes": 求人票にはっきり記載がある
- "mid": 記載はあるが曖昧・条件付き
- "no": 求人票に記載がない
`;

			// 4. Geminiを呼び出す
			let aiResults;
			try {
				aiResults = await callGemini(prompt, env.GEMINI_API_KEY);
			} catch (err) {
				return Response.json(
					{ error: "AIによる照合に失敗しました", detail: err.message },
					{ status: 500, headers: corsHeaders }
				);
			}

			// 5. 結果をDBに保存する（すでにあれば上書き、なければ新規追加＝honneと同じUPSERT）
			for (const item of aiResults) {
				const condition = conditions.find((c) => c.label === item.label);
				if (!condition) continue; // AIが知らない条件名を返してきた場合はスキップ

				await env.DB.prepare(
					`INSERT INTO requirement_matches (company_id, condition_id, mark, note)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(company_id, condition_id) DO UPDATE
			 SET mark = excluded.mark, note = excluded.note, updated_at = CURRENT_TIMESTAMP`
				).bind(company_id, condition.id, item.mark, item.note || null).run();
			}

			// 6. AI再照合したこと自体も記録する（記録には残すが、成長段階の判定には使わない）
			await addRecord(env, company_id, "rematch", "AIが希望条件と照合");

			return Response.json({ message: "照合しました", results: aiResults }, { headers: corsHeaders });
		}

		// GET /records?company_id=1 : 特定の企業の記録一覧（詳細画面のタイムライン用）
		// GET /records : 全企業分の最新の記録（記録画面の「最近の記録」用）
		if (request.method === "GET" && url.pathname === "/records") {
			const companyId = url.searchParams.get("company_id");

			if (companyId) {
				const { results } = await env.DB.prepare(
					"SELECT * FROM records WHERE company_id = ? ORDER BY created_at DESC"
				).bind(companyId).all();
				return Response.json(results, { headers: corsHeaders });
			}

			// company_idの指定がなければ、全企業分を新しい順に取得
			// （ホーム画面から「その企業の詳細」に飛べるよう、company_idも一緒に返す）
			const { results } = await env.DB.prepare(
				`SELECT r.id, r.category, r.title, r.note, r.created_at, c.id AS company_id, c.company_name
				 FROM records r
				 JOIN companies c ON r.company_id = c.id
				 ORDER BY r.created_at DESC
				 LIMIT 20`
			).all();
			return Response.json(results, { headers: corsHeaders });
		}

		return new Response("Mebae API is running!", { status: 200, headers: corsHeaders });
	},
};
