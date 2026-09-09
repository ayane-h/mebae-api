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

		// GET /companies : 企業一覧の取得
		if (request.method === "GET" && url.pathname === "/companies") {
			const { results } = await env.DB.prepare(
				"SELECT * FROM companies ORDER BY created_at DESC"
			).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /companies : 企業の新規登録
		if (request.method === "POST" && url.pathname === "/companies") {
			const body = await request.json();
			const { company_name, job_url, job_text, interest_level } = body;

			// 開発初期のため user_id は固定（ダミー）
			const userId = "dummy_user_123";

			await env.DB.prepare(
				`INSERT INTO companies (user_id, company_name, job_url, job_text, interest_level)
				VALUES (?, ?, ?, ?, ?)`
			).bind(userId, company_name, job_url || null, job_text || null, interest_level || 3).run();

			return Response.json({ message: "Company added successfully!" }, { status: 201, headers: corsHeaders });
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

			return Response.json({ success: true }, { status: 201, headers: corsHeaders });
		}

		// DELETE /impressions/:id : いいな・気になるを削除
		if (request.method === "DELETE" && url.pathname.startsWith("/impressions/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare("DELETE FROM impressions WHERE id = ?").bind(id).run();
			return Response.json({ success: true }, { headers: corsHeaders });
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

			return Response.json({ message: "照合しました", results: aiResults }, { headers: corsHeaders });
		}

		return new Response("Mebae API is running!", { status: 200, headers: corsHeaders });
	},
};