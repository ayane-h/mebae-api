import { verifyToken, createClerkClient } from "@clerk/backend";
import { seedDemoData } from "./demo.js";

// バイト列を16進数の文字列に変換する（結果を見やすく表示するための補助関数）
function bytesToHex(bytes) {
	return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- 認証：フロントエンドとして許可する場所 ----
// Clerkのトークンには「どのサイトで発行されたか」が入っている。ここに書いたサイト以外で
// 発行されたトークンは受け付けない（他のサイトで発行されたトークンの使い回しを防ぐため）。
// Viteのポートが5173以外になった場合や、Vercelで公開した時は、ここにURLを追加する。
const ALLOWED_FRONTEND_ORIGINS = [
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"https://mebae-app.vercel.app", // 本番（Vercel）※最後に「/」を付けない
];

// 企業一覧の1行に収まる、ひとことメモの最大文字数（フロントエンド側と同じ値にしておく）
const SHORT_MEMO_MAX = 10;
// 選考フローの最大文字数（複数行で書けるようにしたので、長すぎるものは断る）
const SELECTION_FLOW_MAX = 1000;
// 求人ページのURLの最大文字数
const JOB_URL_MAX = 2000;
// 関連リンク（採用ページ・企業HPなど）の、名前の最大文字数と、1社あたりの件数の上限
const LINK_LABEL_MAX = 20;
const LINKS_PER_COMPANY_MAX = 10;
// 希望条件の件数の上限と、1件の最大文字数（フロントエンド側と同じ値にしておく）
// 件数が多いと、照合結果の保存でデータベースの操作回数が増え、AIの返事も長くなるため
const CONDITIONS_MAX = 10;
const CONDITION_LABEL_MAX = 30;
// 求人票の本文の最大文字数（フロントエンド側と同じ値にしておく）
// AIに送る量は、ここがいちばん大きい。ページ全体を貼り付けたような、極端に長い文を防ぐ
const JOB_TEXT_MAX = 10000;

// ---- デモ（「🌱 デモで試してみる」）の設定 ----
// 選考ステータスを押し間違えた時に、「押し直し」として扱う時間（分）
// この時間内の押し直しは、記録を増やさずに、直前の記録を書き換える（または取り消す）
const STATUS_UNDO_MINUTES = 10;

const DEMO_REMATCH_LIMIT = 3;  // デモの人がAI照合を使える回数
const DEMO_DAILY_LIMIT = 20;   // 1日に作れるデモの数（ボタンの連打などで、Clerkのユーザーが増えすぎないように）
const DEMO_TOTAL_LIMIT = 80;   // デモの合計の上限（ClerkのDevelopment環境は100ユーザーまでなので、自分の分の余裕を残す）
const DEMO_KEEP_DAYS = 3;        // デモを残しておく日数（これより古いデモは、自動で片づける）
const DEMO_CLEANUP_BATCH = 10;   // 1回の片づけで消す人数の上限（一度にたくさん処理して、制限に当たらないように）

// ---- 認証：リクエストに添えられたClerkのトークンを検証して、ログイン中のユーザーIDを返す ----
// 本物のトークンなら user_xxxxx のようなIDを返し、無い・偽物・期限切れなら null を返す
async function getUserId(request, env) {
	const authHeader = request.headers.get("Authorization") || "";
	const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
	if (!token) {
		console.error("トークンが添えられていません");
		return null;
	}

	try {
		const options = {
			secretKey: env.CLERK_SECRET_KEY,
			authorizedParties: ALLOWED_FRONTEND_ORIGINS,
		};
		// CLERK_JWT_KEY（Clerkの公開鍵）を登録してあれば、通信なしで検証できる（任意）
		if (env.CLERK_JWT_KEY) options.jwtKey = env.CLERK_JWT_KEY;

		const result = await verifyToken(token, options);

		// ライブラリのバージョンによって、「中身そのもの」か「{ data, errors }」のどちらかで返ってくるため、両方に対応する
		// （errorsが空の配列 [] の場合は、エラーなしとして扱う）
		const hasErrors = Array.isArray(result?.errors)
			? result.errors.length > 0
			: !!(result?.errors || result?.error);
		if (hasErrors) {
			console.error("トークンの検証に失敗しました:", JSON.stringify(result.errors || result.error));
			return null;
		}
		const claims = result && "data" in result ? result.data : result;
		return claims && claims.sub ? claims.sub : null;
	} catch (err) {
		console.error("トークンの検証に失敗しました:", err.message);
		return null;
	}
}

// ---- あるユーザーのデータを、すべて消すためのSQLをまとめて作る ----
// 企業を消す前に、企業に紐づくデータを先に消す必要があるので、この順番で並べている
// （「データを削除」と、古いデモの片づけの両方で使う）
function userDataDeleteStatements(env, userId) {
	const ownCompanyIds = "(SELECT id FROM companies WHERE user_id = ?)";
	return [
		env.DB.prepare(`DELETE FROM impressions WHERE company_id IN ${ownCompanyIds}`).bind(userId),
		env.DB.prepare(`DELETE FROM honne WHERE company_id IN ${ownCompanyIds}`).bind(userId),
		env.DB.prepare(`DELETE FROM memos WHERE company_id IN ${ownCompanyIds}`).bind(userId),
		env.DB.prepare(`DELETE FROM requirement_matches WHERE company_id IN ${ownCompanyIds}`).bind(userId),
		env.DB.prepare(`DELETE FROM records WHERE company_id IN ${ownCompanyIds}`).bind(userId),
		env.DB.prepare(`DELETE FROM ai_suggestions WHERE company_id IN ${ownCompanyIds}`).bind(userId),
		env.DB.prepare(`DELETE FROM company_links WHERE company_id IN ${ownCompanyIds}`).bind(userId),
		env.DB.prepare("DELETE FROM desired_conditions WHERE user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM companies WHERE user_id = ?").bind(userId),
	];
}

// ---- 庭の「鉢の場所」と「花の種類」 ----
// どちらも、企業ごとにデータベースに保存しておく（companies の garden_slot / flower_kind）。
//   garden_slot … 庭の何番目の場所か（0から数える。8か所で1つの庭なので、8以上は2つ目の庭）
//   flower_kind … 咲く花の種類の名前
// 保存しておくと、眠らせても ほかの鉢が動かず、花の種類を増やしても 咲いている花が入れ替わらない。

// 花の種類の名前。フロントエンド（Garden.jsx の FLOWERS の kind）と同じ名前にしておく。
// 花を増やす時は、Garden.jsx に画像を足して、ここにも名前を足す
const FLOWER_KINDS = ["sunflower", "tulip", "daisy", "bellflower", "nemophila"];

// 使われていない場所のうち、いちばん小さい番号を返す（used：使われている番号の集まり）
function lowestFreeSlot(used) {
	let slot = 0;
	while (used.has(slot)) slot++;
	return slot;
}

// まだ花の種類が決まっていない企業のための、番号(id)から決める花
// （保存する仕組みを入れる前と、同じ花になる式。今まで咲いていた花が、入れ替わらないようにするため）
function defaultFlowerKind(id) {
	const n = FLOWER_KINDS.length;
	return FLOWER_KINDS[(id + Math.floor(id / n)) % n];
}

// 新しく植える企業の花を選ぶ：その人の庭で、いちばん数が少ない種類にする（同じ花ばかりにならないように）
// existingKinds：その人の企業にすでに付いている、花の種類の配列
function pickFlowerKind(existingKinds) {
	const n = FLOWER_KINDS.length;
	const counts = FLOWER_KINDS.map((kind) => existingKinds.filter((k) => k === kind).length);
	const min = Math.min(...counts);
	// 同じ数の種類がいくつかある時に、いつも先頭の花にならないよう、企業の数だけ、探し始める位置をずらす
	const start = existingKinds.length % n;
	for (let i = 0; i < n; i++) {
		const index = (start + i) % n;
		if (counts[index] === min) return FLOWER_KINDS[index];
	}
	return FLOWER_KINDS[0];
}

// 鉢の場所・花の種類がまだ決まっていない企業に、値を決めて保存する
// （この仕組みを入れる前からある企業や、デモの見本データのため。すでに決まっている企業は、何もしない）
// companies：1人ぶんの企業の配列（id / is_sleeping / garden_slot / flower_kind を持つもの）。中身を書き換える
async function ensureGardenData(env, companies) {
	const byId = [...companies].sort((a, b) => a.id - b.id); // 植えた順
	const used = new Set();     // 起きている企業が使っている場所
	const needsSlot = new Set(); // 場所を決め直す必要がある企業のid

	// 1. 起きている企業のうち、場所がきちんと決まっているものを先に数える
	//    （場所が無い・ほかの企業と重なっている時は、決め直す）
	for (const c of byId) {
		if (c.is_sleeping) continue; // 眠っている企業は、場所を取らない
		const valid = Number.isInteger(c.garden_slot) && c.garden_slot >= 0 && !used.has(c.garden_slot);
		if (valid) used.add(c.garden_slot);
		else needsSlot.add(c.id);
	}

	// 2. 決まっていないものに、値を決める（植えた順に、空いている場所の小さい番号から）
	const statements = [];
	for (const c of byId) {
		let changed = false;
		if (needsSlot.has(c.id)) {
			c.garden_slot = lowestFreeSlot(used);
			used.add(c.garden_slot);
			changed = true;
		}
		if (!FLOWER_KINDS.includes(c.flower_kind)) {
			c.flower_kind = defaultFlowerKind(c.id);
			changed = true;
		}
		if (changed) {
			statements.push(
				env.DB.prepare("UPDATE companies SET garden_slot = ?, flower_kind = ? WHERE id = ?")
					.bind(c.garden_slot ?? null, c.flower_kind, c.id)
			);
		}
	}

	// 3. まとめて保存する（変えたものが無ければ、何もしない）
	if (statements.length > 0) await env.DB.batch(statements);
}

// ---- 古いデモの片づけ ----
// 作ってから DEMO_KEEP_DAYS 日たったデモを、古い順に消す（Clerkのユーザー数の上限対策）
// 1人ずつ「Clerkのユーザー → D1のデータ」の順に消す。
// Clerk側で失敗した時は、D1のデータを残しておく（次の回に、もう一度やり直せるように）
async function cleanupOldDemoUsers(env) {
	const { results: oldDemos } = await env.DB.prepare(
		`SELECT user_id FROM demo_users
		 WHERE created_at < datetime('now', ?)
		 ORDER BY created_at ASC
		 LIMIT ?`
	).bind(`-${DEMO_KEEP_DAYS} days`, DEMO_CLEANUP_BATCH).all();

	if (oldDemos.length === 0) return { deleted: 0, failed: 0 };

	const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
	let deleted = 0;
	let failed = 0;

	for (const demo of oldDemos) {
		try {
			// 1. Clerkのユーザーを消す
			try {
				await clerk.users.deleteUser(demo.user_id);
			} catch (err) {
				// 404（すでにClerk側にいない）は、消し終わっているのと同じなので、そのまま先へ進む
				if (err.status !== 404) throw err;
			}

			// 2. D1のデータと、demo_users の行をまとめて消す
			//    （batchなので、途中で失敗した場合は、全体がなかったことになる）
			await env.DB.batch([
				...userDataDeleteStatements(env, demo.user_id),
				env.DB.prepare("DELETE FROM demo_users WHERE user_id = ?").bind(demo.user_id),
			]);
			deleted++;
		} catch (err) {
			failed++;
			console.error("古いデモの削除に失敗しました:", demo.user_id, err.message);
		}
	}

	console.log(`古いデモの片づけ：${deleted}人を削除、${failed}人が失敗`);
	return { deleted, failed };
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// フロントエンド（別のポート）からのアクセスを許可する設定
		// Authorization は、ログイン中のトークンを添えるために必要
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		};

		// ブラウザが本番リクエストの前に送る確認リクエストへの応答（ここではログイン確認をしない）
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		// 動作確認用のトップページだけは、ログインなしで見られるようにしておく
		if (url.pathname === "/") {
			return new Response("Mebae API is running!", { status: 200, headers: corsHeaders });
		}

		// POST /demo/start : デモ用のユーザーと見本データを作り、ログイン用の「1回限りの合言葉」を返す
		// （まだログインしていない人が押すボタンなので、ログイン確認より前に置いている）
		if (request.method === "POST" && url.pathname === "/demo/start") {
			// 使いすぎ防止：1日の数・合計の数が上限に達していたら、新しいデモは作らない
			const daily = await env.DB.prepare(
				"SELECT COUNT(*) AS cnt FROM demo_users WHERE created_at >= datetime('now', '-1 day')"
			).first();
			const total = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM demo_users").first();
			if (daily.cnt >= DEMO_DAILY_LIMIT || total.cnt >= DEMO_TOTAL_LIMIT) {
				return Response.json(
					{ error: "ただいまデモが混み合っています。時間をおいてお試しください" },
					{ status: 429, headers: corsHeaders }
				);
			}

			try {
				const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

				// 1. Clerkにデモ用のユーザーを作る（メールアドレスは架空のもの。パスワードは不要）
				const suffix = crypto.randomUUID().slice(0, 8);
				const demoUser = await clerk.users.createUser({
					emailAddress: [`demo-${suffix}@example.com`],
					firstName: "デモ",
					skipPasswordRequirement: true,
					publicMetadata: { demo: true },
				});

				// 2. 「この人はデモの人」と記録し、見本データを入れる
				await env.DB.prepare("INSERT INTO demo_users (user_id) VALUES (?)").bind(demoUser.id).run();
				await seedDemoData(env, demoUser.id);

				// 3. 入力なしで1回だけログインできる合言葉（Sign-in Token）を発行する（5分で期限切れ）
				const signInToken = await clerk.signInTokens.createSignInToken({
					userId: demoUser.id,
					expiresInSeconds: 300,
				});

				return Response.json({ ticket: signInToken.token }, { headers: corsHeaders });
			} catch (err) {
				console.error("デモの準備に失敗しました:", err.message, JSON.stringify(err.errors || ""));
				return Response.json(
					{ error: "デモの準備に失敗しました。時間をおいてお試しください" },
					{ status: 500, headers: corsHeaders }
				);
			}
		}

		// ---- ここから先は、ログインしている人だけが使える ----
		const userId = await getUserId(request, env);
		if (!userId) {
			return Response.json({ error: "ログインが必要です" }, { status: 401, headers: corsHeaders });
		}

		// 他人のデータや存在しないデータには、「見つかりません」と返す
		// （「他人のデータがある」ことを教えないよう、403ではなく404にしている）
		const notFound = () =>
			Response.json({ error: "見つかりません" }, { status: 404, headers: corsHeaders });

		// ログイン中の人がデモの人なら、そのデモの情報（AI照合の使用回数など）を返す。デモでなければ null
		async function getDemoUser() {
			return await env.DB.prepare(
				"SELECT user_id, rematch_count FROM demo_users WHERE user_id = ?"
			).bind(userId).first();
		}

		// GET /me : ログイン中の人の情報（デモかどうか・AI照合の残り回数）
		if (request.method === "GET" && url.pathname === "/me") {
			const demo = await getDemoUser();
			return Response.json({
				is_demo: !!demo,
				rematch_limit: DEMO_REMATCH_LIMIT,
				rematch_remaining: demo ? Math.max(0, DEMO_REMATCH_LIMIT - demo.rematch_count) : null,
			}, { headers: corsHeaders });
		}

		// この企業は、ログイン中のユーザー本人のものか？を確認する
		async function ownsCompany(companyId) {
			if (!companyId) return false;
			const row = await env.DB.prepare(
				"SELECT id FROM companies WHERE id = ? AND user_id = ?"
			).bind(companyId, userId).first();
			return !!row;
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
				"SELECT * FROM companies WHERE user_id = ? ORDER BY created_at DESC"
			).bind(userId).all();

			// 鉢の場所・花の種類がまだ決まっていない企業があれば、ここで決めて保存する
			// （保存に失敗しても、一覧は返す。画面側は、場所が無い時は植えた順に並べる）
			try {
				await ensureGardenData(env, companies);
			} catch (err) {
				console.error("鉢の場所・花の種類の保存に失敗しました:", err.message);
			}

			// 自分の企業のrecordsだけを、一度にまとめて取得する
			const { results: allRecords } = await env.DB.prepare(
				`SELECT r.company_id, r.category, r.created_at
				 FROM records r
				 JOIN companies c ON r.company_id = c.id
				 WHERE c.user_id = ?`
			).bind(userId).all();

			// company_idごとに、カテゴリの配列と、いちばん新しい記録の日時をまとめる
			const categoriesByCompany = {};
			const lastActivityByCompany = {};
			for (const r of allRecords) {
				if (!categoriesByCompany[r.company_id]) categoriesByCompany[r.company_id] = [];
				categoriesByCompany[r.company_id].push(r.category);

				if (!lastActivityByCompany[r.company_id] || r.created_at > lastActivityByCompany[r.company_id]) {
					lastActivityByCompany[r.company_id] = r.created_at;
				}
			}

			// 希望条件との照合結果（○△×）も、企業ごとにまとめておく（企業一覧に、小さな点で出すため）
			// 希望条件の並び順（sort_order）どおりに取り出すので、配列の順番も、希望条件の並びと同じになる
			const { results: allMarks } = await env.DB.prepare(
				`SELECT rm.company_id, rm.mark
				 FROM requirement_matches rm
				 JOIN companies c ON rm.company_id = c.id
				 JOIN desired_conditions dc ON rm.condition_id = dc.id
				 WHERE c.user_id = ?
				 ORDER BY dc.sort_order ASC, dc.created_at ASC`
			).bind(userId).all();

			const marksByCompany = {};
			for (const m of allMarks) {
				if (!marksByCompany[m.company_id]) marksByCompany[m.company_id] = [];
				marksByCompany[m.company_id].push(m.mark);
			}

			// 各企業オブジェクトに、成長段階(growth_stage)と、最後に記録した日時(last_activity_at)を追加する
			// （last_activity_at は、「しばらく記録がありません」の案内に使う。記録が1件も無ければ、植えた日時）
			const companiesWithStage = companies.map((c) => ({
				...c,
				growth_stage: calcGrowthStage(categoriesByCompany[c.id] || []),
				last_activity_at: lastActivityByCompany[c.id] || c.created_at,
				// 希望条件との照合結果（"yes" | "mid" | "no" の配列）。まだ照合していなければ、空の配列
				match_marks: marksByCompany[c.id] || [],
			}));

			return Response.json(companiesWithStage, { headers: corsHeaders });
		}

		// POST /companies : 企業の新規登録（持ち主は、ログイン中のユーザー）
		if (request.method === "POST" && url.pathname === "/companies") {
			const body = await request.json();
			const { company_name, job_url, job_text, interest_level } = body;

			// 求人票の本文が長すぎる時は、登録しない
			if (typeof job_text === "string" && job_text.length > JOB_TEXT_MAX) {
				return Response.json(
					{ error: `求人票の本文は${JOB_TEXT_MAX.toLocaleString("ja-JP")}文字以内で入力してください` },
					{ status: 400, headers: corsHeaders }
				);
			}

			// 鉢の場所と花の種類を決める
			// （先に、今ある企業の場所をそろえておく。そのうえで、起きている企業が使っていない、いちばん小さい番号の場所に置く）
			const { results: mine } = await env.DB.prepare(
				"SELECT id, is_sleeping, garden_slot, flower_kind FROM companies WHERE user_id = ?"
			).bind(userId).all();
			await ensureGardenData(env, mine);
			const usedSlots = new Set(mine.filter((c) => !c.is_sleeping).map((c) => c.garden_slot));
			const gardenSlot = lowestFreeSlot(usedSlots);
			const flowerKind = pickFlowerKind(mine.map((c) => c.flower_kind));

			const result = await env.DB.prepare(
				`INSERT INTO companies (user_id, company_name, job_url, job_text, interest_level, garden_slot, flower_kind)
				VALUES (?, ?, ?, ?, ?, ?, ?)`
			).bind(userId, company_name, job_url || null, job_text || null, interest_level || 3, gardenSlot, flowerKind).run();

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
			if (!(await ownsCompany(id))) return notFound();

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
			if (body.is_favorite !== undefined) {
				fields.push("is_favorite = ?");
				values.push(body.is_favorite ? 1 : 0);
			}
			if (body.is_sleeping !== undefined) {
				fields.push("is_sleeping = ?");
				values.push(body.is_sleeping ? 1 : 0);

				// 眠りから起こす時：元の場所が空いていれば、そこに戻す。
				// 眠っている間に別の企業が入っていたら、空いている場所の小さい番号に置く
				// （眠らせる時は、場所の番号をそのまま残しておく。起こした時に、元の場所へ戻れるように）
				if (!body.is_sleeping) {
					const { results: mine } = await env.DB.prepare(
						"SELECT id, is_sleeping, garden_slot, flower_kind FROM companies WHERE user_id = ?"
					).bind(userId).all();
					await ensureGardenData(env, mine);
					const target = mine.find((c) => String(c.id) === String(id));
					const usedByOthers = new Set(
						mine.filter((c) => !c.is_sleeping && String(c.id) !== String(id)).map((c) => c.garden_slot)
					);
					const keepsOwnSlot =
						target && Number.isInteger(target.garden_slot) && !usedByOthers.has(target.garden_slot);
					if (!keepsOwnSlot) {
						fields.push("garden_slot = ?");
						values.push(lowestFreeSlot(usedByOthers));
					}
				}
			}
			if (body.short_memo !== undefined) {
				// 前後の空白を取り除き、空ならnull（メモなし）として保存する
				const memo = (body.short_memo || "").trim();
				if (memo.length > SHORT_MEMO_MAX) {
					return Response.json(
						{ error: `ひとことメモは${SHORT_MEMO_MAX}文字以内で入力してください` },
						{ status: 400, headers: corsHeaders }
					);
				}
				fields.push("short_memo = ?");
				values.push(memo || null);
			}
			if (body.job_text !== undefined) {
				// 求人票の本文を保存する
				// （以前は、本文が変わると「選考フローは手動で編集済み」の印を外していたが、
				//   誤字を1文字直しただけでも手入力した選考フローがAIに上書きされてしまうため、やめた。
				//   手入力した選考フローは、本人が空にするまでずっと残す）
				if (typeof body.job_text === "string" && body.job_text.length > JOB_TEXT_MAX) {
					return Response.json(
						{ error: `求人票の本文は${JOB_TEXT_MAX.toLocaleString("ja-JP")}文字以内で入力してください` },
						{ status: 400, headers: corsHeaders }
					);
				}
				fields.push("job_text = ?");
				values.push(body.job_text);
			}
			if (body.job_url !== undefined) {
				// 求人ページのURL。前後の空白を取り除き、空ならnull（URLなし）として保存する
				const jobUrl = String(body.job_url || "").trim();
				// 画面ではリンクとして開くので、http:// か https:// で始まるものだけ受け付ける
				if (jobUrl && !/^https?:\/\//i.test(jobUrl)) {
					return Response.json(
						{ error: "求人ページのURLは、http:// か https:// から始まる形で入力してください" },
						{ status: 400, headers: corsHeaders }
					);
				}
				if (jobUrl.length > JOB_URL_MAX) {
					return Response.json(
						{ error: "求人ページのURLが長すぎます" },
						{ status: 400, headers: corsHeaders }
					);
				}
				fields.push("job_url = ?");
				values.push(jobUrl || null);
			}
			if (body.selection_flow !== undefined) {
				// 選考フロー（複数行で書ける）。前後の空白・改行を取り除く
				const flow = String(body.selection_flow || "").trim();
				if (flow.length > SELECTION_FLOW_MAX) {
					return Response.json(
						{ error: `選考フローは${SELECTION_FLOW_MAX}文字以内で入力してください` },
						{ status: 400, headers: corsHeaders }
					);
				}
				// 中身があれば「手動で編集済み」の印を立てる（AI照合で上書きされなくなる）
				// 空にして保存した時は印を外す（次のAI照合で、求人票から読み取り直してもらえる）
				fields.push("selection_flow = ?");
				fields.push("selection_flow_manually_edited = ?");
				values.push(flow || null);
				values.push(flow ? 1 : 0);
			}

			// 更新する項目が1つもなければ、何もせずに成功を返す
			if (fields.length === 0) {
				return Response.json({ success: true }, { headers: corsHeaders });
			}

			values.push(id);
			values.push(userId);

			// ステータスの記録を正しく残すために、更新する前のステータスを控えておく
			let statusBefore = null;
			if (body.status !== undefined) {
				const row = await env.DB.prepare(
					"SELECT status FROM companies WHERE id = ? AND user_id = ?"
				).bind(id, userId).first();
				statusBefore = row ? row.status : null;
			}

			await env.DB.prepare(
				`UPDATE companies SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`
			).bind(...values).run();

			// ステータスが変わった時だけ記録する（志望度の星だけの変更では記録しない）
			// タイトルにステータス名そのものを使う（例:"一次面接"）
			// 今と同じステータスを押しただけの時は、何も記録しない
			if (body.status !== undefined && body.status !== statusBefore) {
				// この企業の一番新しい記録を調べる（recent は「STATUS_UNDO_MINUTES分以内か」を 1 / 0 で返す）
				const last = await env.DB.prepare(
					`SELECT id, category, (created_at >= datetime('now', ?)) AS recent
					 FROM records WHERE company_id = ?
					 ORDER BY created_at DESC, id DESC LIMIT 1`
				).bind(`-${STATUS_UNDO_MINUTES} minutes`, id).first();

				if (last && last.category === "status" && last.recent) {
					// 直前の記録がステータス変更で、まだ時間が経っていない → 押し間違いの「押し直し」として扱う
					// 押し間違える前のステータス（1つ前のステータスの記録。無ければ、最初の「応募前」）を調べる
					const prev = await env.DB.prepare(
						`SELECT title FROM records
						 WHERE company_id = ? AND category = 'status' AND id != ?
						 ORDER BY created_at DESC, id DESC LIMIT 1`
					).bind(id, last.id).first();
					const originalStatus = prev ? prev.title : "応募前";

					if (body.status === originalStatus) {
						// 元のステータスに戻した → 押し間違いの記録ごと取り消す
						await env.DB.prepare("DELETE FROM records WHERE id = ?").bind(last.id).run();
					} else {
						// 別のステータスに押し直した → 記録を増やさず、直前の記録を書き換える
						await env.DB.prepare(
							"UPDATE records SET title = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?"
						).bind(body.status, last.id).run();
					}
				} else {
					await addRecord(env, id, "status", body.status);
				}
			}

			// 求人票の本文を、あとから追加した場合も「求人を知る」として数える
			// （まだ求人票の記録が1件もない企業に、本文が入った時だけ記録する。2回目以降は記録しない）
			if (typeof body.job_text === "string" && body.job_text.trim()) {
				const existing = await env.DB.prepare(
					"SELECT id FROM records WHERE company_id = ? AND category = 'job_text' LIMIT 1"
				).bind(id).first();
				if (!existing) {
					await addRecord(env, id, "job_text", "求人票を追加");
				}
			}

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// GET /impressions?company_id=1 : 特定の企業のいいな・気になるを取得
		if (request.method === "GET" && url.pathname === "/impressions") {
			const companyId = url.searchParams.get("company_id");
			if (!(await ownsCompany(companyId))) return notFound();

			const { results } = await env.DB.prepare(
				"SELECT * FROM impressions WHERE company_id = ? ORDER BY created_at DESC"
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /impressions : いいな・気になるを追加
		if (request.method === "POST" && url.pathname === "/impressions") {
			const body = await request.json();
			const { company_id, type, content } = body;
			if (!(await ownsCompany(company_id))) return notFound();

			await env.DB.prepare(
				"INSERT INTO impressions (company_id, type, content) VALUES (?, ?, ?)"
			).bind(company_id, type, content).run();

			const title = type === "good" ? "いいなを追加" : "気になる点を追加";
			await addRecord(env, company_id, "impression", title, truncate(content));

			return Response.json({ success: true }, { status: 201, headers: corsHeaders });
		}

		// DELETE /impressions/:id : いいな・気になるを削除
		// 「自分の企業に紐づくものだけ」を対象にする条件を、SQLの中に含めている
		if (request.method === "DELETE" && url.pathname.startsWith("/impressions/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare(
				"DELETE FROM impressions WHERE id = ? AND company_id IN (SELECT id FROM companies WHERE user_id = ?)"
			).bind(id, userId).run();
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// PATCH /impressions/:id : いいな・気になるの文言をタップして編集する
		if (request.method === "PATCH" && url.pathname.startsWith("/impressions/")) {
			const id = url.pathname.split("/")[2];
			const body = await request.json();
			const { content } = body;

			await env.DB.prepare(
				"UPDATE impressions SET content = ? WHERE id = ? AND company_id IN (SELECT id FROM companies WHERE user_id = ?)"
			).bind(content, id, userId).run();

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// POST /impressions/batch : 複数の「いいな・気になる」を一度に追加する
		// （＋植える画面のチップ選択のように、1回の操作でまとめて登録したい場合に使う。
		//  記録(records)は1件ずつではなく、全体で1件だけ作る）
		if (request.method === "POST" && url.pathname === "/impressions/batch") {
			const body = await request.json();
			const { company_id, contents } = body; // contents は文字列の配列
			if (!(await ownsCompany(company_id))) return notFound();

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
			if (!(await ownsCompany(companyId))) return notFound();

			const { results } = await env.DB.prepare(
				"SELECT * FROM honne WHERE company_id = ?"
			).bind(companyId).all();
			return Response.json(results[0] || null, { headers: corsHeaders });
		}

		// PUT /honne : 本音を保存（新規作成 or 上書き更新）
		if (request.method === "PUT" && url.pathname === "/honne") {
			const body = await request.json();
			const { company_id, content } = body;
			if (!(await ownsCompany(company_id))) return notFound();

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
			if (!(await ownsCompany(companyId))) return notFound();

			const { results } = await env.DB.prepare(
				"SELECT * FROM memos WHERE company_id = ? ORDER BY created_at DESC"
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /memos : メモを追加
		if (request.method === "POST" && url.pathname === "/memos") {
			const body = await request.json();
			const { company_id, content } = body;
			if (!(await ownsCompany(company_id))) return notFound();

			await env.DB.prepare(
				"INSERT INTO memos (company_id, content) VALUES (?, ?)"
			).bind(company_id, content).run();

			await addRecord(env, company_id, "memo", "メモを追加", truncate(content));

			return Response.json({ success: true }, { status: 201, headers: corsHeaders });
		}

		// DELETE /memos/:id : メモを削除
		if (request.method === "DELETE" && url.pathname.startsWith("/memos/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare(
				"DELETE FROM memos WHERE id = ? AND company_id IN (SELECT id FROM companies WHERE user_id = ?)"
			).bind(id, userId).run();
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// PATCH /memos/:id : メモの文言をタップして編集する
		if (request.method === "PATCH" && url.pathname.startsWith("/memos/")) {
			const id = url.pathname.split("/")[2];
			const body = await request.json();
			const { content } = body;

			await env.DB.prepare(
				"UPDATE memos SET content = ? WHERE id = ? AND company_id IN (SELECT id FROM companies WHERE user_id = ?)"
			).bind(content, id, userId).run();

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// GET /desired-conditions : 自分の希望条件の一覧を取得
		if (request.method === "GET" && url.pathname === "/desired-conditions") {
			const { results } = await env.DB.prepare(
				"SELECT * FROM desired_conditions WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC"
			).bind(userId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /desired-conditions : 希望条件を1件追加（例: "リモート勤務"）
		// 並び順は「自分が今まで登録した数」を使い、常に一番最後に追加されるようにする
		if (request.method === "POST" && url.pathname === "/desired-conditions") {
			const body = await request.json();

			// 前後の空白を取り除いて、中身と長さを確かめる
			const label = String(body.label || "").trim();
			if (!label) {
				return Response.json({ error: "希望条件を入力してください" }, { status: 400, headers: corsHeaders });
			}
			if (label.length > CONDITION_LABEL_MAX) {
				return Response.json(
					{ error: `希望条件は${CONDITION_LABEL_MAX}文字以内で入力してください` },
					{ status: 400, headers: corsHeaders }
				);
			}

			const countRow = await env.DB.prepare(
				"SELECT COUNT(*) AS cnt FROM desired_conditions WHERE user_id = ?"
			).bind(userId).first();

			// 件数の上限に達していたら、追加しない
			if (countRow.cnt >= CONDITIONS_MAX) {
				return Response.json(
					{ error: `希望条件は${CONDITIONS_MAX}件までです` },
					{ status: 400, headers: corsHeaders }
				);
			}

			await env.DB.prepare(
				"INSERT INTO desired_conditions (user_id, label, sort_order) VALUES (?, ?, ?)"
			).bind(userId, label, countRow.cnt).run();

			return Response.json({ message: "Condition added successfully!" }, { status: 201, headers: corsHeaders });
		}

		// PATCH /desired-conditions/reorder : 並び替えた後の順番をまとめて保存する
		// body: { order: [3, 1, 2] } のような、希望条件idを新しい順番で並べた配列
		if (request.method === "PATCH" && url.pathname === "/desired-conditions/reorder") {
			const body = await request.json();
			const { order } = body;
			if (!Array.isArray(order)) {
				return Response.json({ error: "orderは配列で指定してください" }, { status: 400, headers: corsHeaders });
			}

			for (let i = 0; i < order.length; i++) {
				await env.DB.prepare(
					"UPDATE desired_conditions SET sort_order = ? WHERE id = ? AND user_id = ?"
				).bind(i, order[i], userId).run();
			}

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// PATCH /desired-conditions/:id : 希望条件の文言をタップして編集する
		if (request.method === "PATCH" && url.pathname.startsWith("/desired-conditions/")) {
			const id = url.pathname.split("/")[2];
			const body = await request.json();

			// 追加の時と同じように、中身と長さを確かめる
			const label = String(body.label || "").trim();
			if (!label) {
				return Response.json({ error: "希望条件を入力してください" }, { status: 400, headers: corsHeaders });
			}
			if (label.length > CONDITION_LABEL_MAX) {
				return Response.json(
					{ error: `希望条件は${CONDITION_LABEL_MAX}文字以内で入力してください` },
					{ status: 400, headers: corsHeaders }
				);
			}

			await env.DB.prepare(
				"UPDATE desired_conditions SET label = ? WHERE id = ? AND user_id = ?"
			).bind(label, id, userId).run();

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// DELETE /desired-conditions/:id : 希望条件を1件削除
		if (request.method === "DELETE" && url.pathname.startsWith("/desired-conditions/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare(
				"DELETE FROM desired_conditions WHERE id = ? AND user_id = ?"
			).bind(id, userId).run();
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// ---- Geminiを呼び出す共通処理 ----
		// promptで質問を投げて、返ってきたJSONをそのままオブジェクトとして受け取る
		// Geminiが混雑している時（503など）は失敗しやすいので、少し待って最大3回までやり直す
		async function callGemini(prompt, apiKey) {
			// 429（回数の上限）は、すぐやり直しても通らないので対象から外す
			const RETRYABLE_STATUS = [500, 503]; // やり直せば成功する可能性があるエラー（混雑など）
			const MAX_ATTEMPTS = 3;
			let lastError;

			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
				try {
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
						const err = new Error(`Gemini API error: ${response.status} ${errText}`);
						err.status = response.status;
						err.retryable = RETRYABLE_STATUS.includes(response.status);
						throw err;
					}

					// 返事の中身を、途中が欠けていても壊れないように取り出す
					const data = await response.json();
					const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
					if (!text) {
						const err = new Error("Geminiの返事に本文がありませんでした");
						err.kind = "bad_response";
						err.retryable = true;
						throw err;
					}
					try {
						return JSON.parse(text); // 文字列のJSONを、扱いやすいオブジェクトに変換
					} catch {
						const err = new Error("Geminiの返事がJSONの形になっていませんでした");
						err.kind = "bad_response";
						err.retryable = true;
						throw err;
					}
				} catch (err) {
					lastError = err;
					// 通信そのものの失敗（statusが無いエラー）も、やり直す対象にする
					const retryable = err.retryable ?? true;
					if (!retryable || attempt === MAX_ATTEMPTS) break;

					console.warn(`Geminiの呼び出しに失敗しました（${attempt}回目）。やり直します:`, err.message);
					await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1))); // 1秒 → 2秒 と待つ
				}
			}
			throw lastError;
		}

		// GET /requirement-matches?company_id=1 : 照合結果の一覧を取得
		if (request.method === "GET" && url.pathname === "/requirement-matches") {
			const companyId = url.searchParams.get("company_id");
			if (!(await ownsCompany(companyId))) return notFound();

			// requirement_matches と desired_conditions を「条件の名前」で結びつけて取得する
			// 並び順は希望条件側のsort_orderに合わせる（希望条件の並びを変えると、ここも連動する）
			const { results } = await env.DB.prepare(
				`SELECT rm.id, rm.mark, rm.note, rm.manually_edited, dc.id AS condition_id, dc.label
		 FROM requirement_matches rm
		 JOIN desired_conditions dc ON rm.condition_id = dc.id
		 WHERE rm.company_id = ?
		 ORDER BY dc.sort_order ASC, dc.created_at ASC`
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// PATCH /requirement-matches/:id : 手動でmarkを書き換える（表をタップした時）
		// タップして直した記録として manually_edited = 1 を立てる
		if (request.method === "PATCH" && url.pathname.startsWith("/requirement-matches/")) {
			const id = url.pathname.split("/")[2];
			const body = await request.json();
			const { mark } = body;

			await env.DB.prepare(
				`UPDATE requirement_matches SET mark = ?, manually_edited = 1, updated_at = CURRENT_TIMESTAMP
				 WHERE id = ? AND company_id IN (SELECT id FROM companies WHERE user_id = ?)`
			).bind(mark, id, userId).run();

			return Response.json({ success: true, mark }, { headers: corsHeaders });
		}

		// POST /requirement-matches/rematch : 求人票と希望条件をAIに照らし合わせてもらう
		// あわせて、選考メモの提案（面接で確認するとよい質問）もAIに考えてもらう
		if (request.method === "POST" && url.pathname === "/requirement-matches/rematch") {
			const body = await request.json();
			const { company_id } = body;

			// 0. デモの人は、AI照合を使える回数に上限がある
			const demoUser = await getDemoUser();
			if (demoUser && demoUser.rematch_count >= DEMO_REMATCH_LIMIT) {
				return Response.json(
					{ error: `デモでのAI照合は${DEMO_REMATCH_LIMIT}回までです`, code: "demo_limit" },
					{ status: 429, headers: corsHeaders }
				);
			}

			// 1. 対象企業の求人票本文を取得（自分の企業でなければ「見つかりません」）
			const company = await env.DB.prepare(
				"SELECT job_text, selection_flow_manually_edited FROM companies WHERE id = ? AND user_id = ?"
			).bind(company_id, userId).first();

			if (!company) return notFound();

			if (!company.job_text) {
				return Response.json(
					{ error: "求人票の本文が登録されていません", code: "no_job_text" },
					{ status: 400, headers: corsHeaders }
				);
			}

			// 2. 自分の希望条件リストを取得
			const { results: conditions } = await env.DB.prepare(
				"SELECT id, label FROM desired_conditions WHERE user_id = ? ORDER BY created_at ASC"
			).bind(userId).all();

			if (conditions.length === 0) {
				return Response.json(
					{ error: "希望条件が1件も登録されていません", code: "no_conditions" },
					{ status: 400, headers: corsHeaders }
				);
			}

			// 2.5 すでに自分で書いている選考メモを取得（AIへの提案が重複しないようにするため）
			const { results: existingMemos } = await env.DB.prepare(
				"SELECT content FROM memos WHERE company_id = ?"
			).bind(company_id).all();
			const existingMemoText = existingMemos.length > 0
				? existingMemos.map((m) => `・${m.content}`).join("\n")
				: "（まだ何もありません）";

			// 3. Geminiに渡す質問文（プロンプト）を組み立てる
			const conditionLabels = conditions.map((c) => c.label).join("、");

			// 選考フローが手動編集済みなら、
			// AIに選考フローを考えさせること自体を省略する（時間・コストの節約）
			const needsSelectionFlow = !company.selection_flow_manually_edited;

			const selectionFlowTask = needsSelectionFlow
				? "また、求人票の中に選考フロー（書類選考→面接→内定 のような選考の流れ）が書かれていれば、それも抽出してください。\n"
				: "";
			const selectionFlowFormat = needsSelectionFlow
				? `,\n  "selection_flow": "選考フローの文字列、または記載がなければ「記載なし」"`
				: "";
			const selectionFlowRule = needsSelectionFlow
				? `\n選考フローの条件:
- 求人票に書かれている内容だけを書き写す。書かれていないことを推測して作らない
- 「書類選考 → 一次面接 → 最終面接」のように「→」で区切った短い形にする
- 求人票のどこにも選考フローの記載がなければ、必ず「記載なし」とだけ書く`
				: "";

			const prompt = `
あなたは転職活動中の求人票を読んで、希望条件と照らし合わせるアシスタントです。
以下の求人票の文章を読み、各希望条件について求人票に記載があるかを判定してください。
あわせて、求人票全体（特に△・×がついた項目）を踏まえて、面接で確認するとよい質問も2つ考えてください。
${selectionFlowTask}
# 求人票
${company.job_text}

# 希望条件（${conditions.length}件）
${conditionLabels}

# すでに自分で書いている選考メモ（この内容と重複しない質問を考えてください）
${existingMemoText}

# 出力形式
次の形式のJSONだけを出力してください（説明文は不要です）。
{
  "matches": [
    { "label": "条件名", "mark": "yes" または "mid" または "no", "note": "根拠となる一言（15文字程度）" }
  ],
  "suggested_questions": ["質問1", "質問2"]${selectionFlowFormat}
}

判定基準:
- "yes": 求人票にはっきり記載がある
- "mid": 記載はあるが曖昧・条件付き
- "no": 求人票に記載がない

質問の条件:
- 20文字前後の短い一文にする
- △・×がついた条件を優先して考える
${selectionFlowRule}
`;

			// 4. Geminiを呼び出す
			let aiResult;
			try {
				aiResult = await callGemini(prompt, env.GEMINI_API_KEY);
			} catch (err) {
				console.error("AIによる照合に失敗しました:", err.message);

				// 失敗の理由を、画面で出し分けられるように分類する
				// ai_quota：回数制限（429） / ai_busy：混雑・通信の失敗 / ai_failed：それ以外
				let code = "ai_failed";
				let status = 500;
				if (err.status === 429) {
					code = "ai_quota";
					status = 429;
				} else if (err.status === 500 || err.status === 503 || (err.status === undefined && err.kind !== "bad_response")) {
					code = "ai_busy";
					status = 503;
				}

				return Response.json(
					{ error: "AIによる照合に失敗しました", code, detail: err.message },
					{ status, headers: corsHeaders }
				);
			}

			// AI照合が成功したので、デモの人の使用回数を1つ増やす（失敗した時は数えない）
			if (demoUser) {
				await env.DB.prepare(
					"UPDATE demo_users SET rematch_count = rematch_count + 1 WHERE user_id = ?"
				).bind(userId).run();
			}

			const aiResults = aiResult.matches || [];
			const suggestedQuestions = aiResult.suggested_questions || [];
			const selectionFlow = aiResult.selection_flow || "記載なし";

			// 5. 照合結果をDBに保存する（すでにあれば上書き、なければ新規追加＝honneと同じUPSERT）
			for (const item of aiResults) {
				const condition = conditions.find((c) => c.label === item.label);
				if (!condition) continue; // AIが知らない条件名を返してきた場合はスキップ

				await env.DB.prepare(
					`INSERT INTO requirement_matches (company_id, condition_id, mark, note, manually_edited)
			 VALUES (?, ?, ?, ?, 0)
			 ON CONFLICT(company_id, condition_id) DO UPDATE
			 SET mark = excluded.mark, note = excluded.note, manually_edited = 0, updated_at = CURRENT_TIMESTAMP`
				).bind(company_id, condition.id, item.mark, item.note || null).run();
			}

			// 5.5 選考メモの提案を保存する
			// 未採用の提案（ai_suggestions）は、いったん全部消してから新しい提案を入れ直す
			// （採用済みのものはすでにmemosに移動済みなので、ここでは影響を受けない）
			await env.DB.prepare("DELETE FROM ai_suggestions WHERE company_id = ?").bind(company_id).run();
			for (const question of suggestedQuestions) {
				await env.DB.prepare(
					"INSERT INTO ai_suggestions (company_id, content) VALUES (?, ?)"
				).bind(company_id, question).run();
			}

			// 5.6 選考フローを保存する（AIによる抽出なので manually_edited は 0 に戻す）
			// ただし、すでに手動で編集済みの場合は、AIの抽出結果で上書きしない（スキップする）
			if (!company.selection_flow_manually_edited) {
				await env.DB.prepare(
					"UPDATE companies SET selection_flow = ?, selection_flow_manually_edited = 0 WHERE id = ? AND user_id = ?"
				).bind(selectionFlow, company_id, userId).run();
			}

			// 6. AI再照合したこと自体も記録する（記録には残すが、成長段階の判定には使わない）
			await addRecord(env, company_id, "rematch", "AIが希望条件と照合");

			return Response.json({ message: "照合しました", results: aiResults }, { headers: corsHeaders });
		}

		// GET /ai-suggestions?company_id=1 : 未採用のAI提案（選考メモの候補）を取得
		if (request.method === "GET" && url.pathname === "/ai-suggestions") {
			const companyId = url.searchParams.get("company_id");
			if (!(await ownsCompany(companyId))) return notFound();

			const { results } = await env.DB.prepare(
				"SELECT * FROM ai_suggestions WHERE company_id = ? ORDER BY id ASC"
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// DELETE /ai-suggestions/:id : AI提案を1件消す（採用した時・不要な時どちらも使う）
		if (request.method === "DELETE" && url.pathname.startsWith("/ai-suggestions/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare(
				"DELETE FROM ai_suggestions WHERE id = ? AND company_id IN (SELECT id FROM companies WHERE user_id = ?)"
			).bind(id, userId).run();
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// ---- 関連リンク（採用ページ・企業HP・別の求人など。1社にいくつでも登録できる） ----

		// 関連リンクの入力を確かめて、整えた値を返す（問題があれば error に理由を入れて返す）
		function readLinkInput(body) {
			const label = String(body.label || "").trim();
			const linkUrl = String(body.url || "").trim();
			if (!label) return { error: "リンクの名前を入力してください" };
			if (label.length > LINK_LABEL_MAX) {
				return { error: `リンクの名前は${LINK_LABEL_MAX}文字以内で入力してください` };
			}
			// 画面ではリンクとして開くので、http:// か https:// で始まるものだけ受け付ける
			if (!/^https?:\/\//i.test(linkUrl)) {
				return { error: "URLは、http:// か https:// から始まる形で入力してください" };
			}
			if (linkUrl.length > JOB_URL_MAX) return { error: "URLが長すぎます" };
			return { label, url: linkUrl };
		}

		// GET /company-links?company_id=1 : 特定の企業の関連リンクを取得（登録した順）
		if (request.method === "GET" && url.pathname === "/company-links") {
			const companyId = url.searchParams.get("company_id");
			if (!(await ownsCompany(companyId))) return notFound();

			const { results } = await env.DB.prepare(
				"SELECT * FROM company_links WHERE company_id = ? ORDER BY id ASC"
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /company-links : 関連リンクを1件追加
		if (request.method === "POST" && url.pathname === "/company-links") {
			const body = await request.json();
			const { company_id } = body;
			if (!(await ownsCompany(company_id))) return notFound();

			const input = readLinkInput(body);
			if (input.error) {
				return Response.json({ error: input.error }, { status: 400, headers: corsHeaders });
			}

			// 1社あたりの件数に上限をつける（際限なく増えないように）
			const countRow = await env.DB.prepare(
				"SELECT COUNT(*) AS cnt FROM company_links WHERE company_id = ?"
			).bind(company_id).first();
			if (countRow.cnt >= LINKS_PER_COMPANY_MAX) {
				return Response.json(
					{ error: `リンクは1社につき${LINKS_PER_COMPANY_MAX}件までです` },
					{ status: 400, headers: corsHeaders }
				);
			}

			const result = await env.DB.prepare(
				"INSERT INTO company_links (company_id, label, url) VALUES (?, ?, ?)"
			).bind(company_id, input.label, input.url).run();

			return Response.json(
				{ success: true, id: result.meta.last_row_id },
				{ status: 201, headers: corsHeaders }
			);
		}

		// PATCH /company-links/:id : 関連リンクの名前・URLを書き直す
		// 「自分の企業に紐づくものだけ」を対象にする条件を、SQLの中に含めている
		if (request.method === "PATCH" && url.pathname.startsWith("/company-links/")) {
			const id = url.pathname.split("/")[2];
			const body = await request.json();

			const input = readLinkInput(body);
			if (input.error) {
				return Response.json({ error: input.error }, { status: 400, headers: corsHeaders });
			}

			await env.DB.prepare(
				`UPDATE company_links SET label = ?, url = ?
				 WHERE id = ? AND company_id IN (SELECT id FROM companies WHERE user_id = ?)`
			).bind(input.label, input.url, id, userId).run();

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// DELETE /company-links/:id : 関連リンクを1件削除
		if (request.method === "DELETE" && url.pathname.startsWith("/company-links/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare(
				"DELETE FROM company_links WHERE id = ? AND company_id IN (SELECT id FROM companies WHERE user_id = ?)"
			).bind(id, userId).run();
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// GET /records?company_id=1 : 特定の企業の記録一覧（詳細画面のタイムライン用）
		// GET /records : 自分の全企業分の最新の記録（記録画面の「最近の記録」用）
		if (request.method === "GET" && url.pathname === "/records") {
			const companyId = url.searchParams.get("company_id");

			if (companyId) {
				if (!(await ownsCompany(companyId))) return notFound();

				const { results } = await env.DB.prepare(
					"SELECT * FROM records WHERE company_id = ? ORDER BY created_at DESC, id DESC"
				).bind(companyId).all();
				return Response.json(results, { headers: corsHeaders });
			}

			// company_idの指定がなければ、自分の全企業分を新しい順に取得
			// （ホーム画面から「その企業の詳細」に飛べるよう、company_idも一緒に返す）
			const { results } = await env.DB.prepare(
				`SELECT r.id, r.category, r.title, r.note, r.created_at, c.id AS company_id, c.company_name
				 FROM records r
				 JOIN companies c ON r.company_id = c.id
				 WHERE c.user_id = ?
				 ORDER BY r.created_at DESC, r.id DESC
				 LIMIT 20`
			).bind(userId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// GET /export : 自分のデータをJSON形式でまとめて取得する（バックアップ用）
		if (request.method === "GET" && url.pathname === "/export") {
			// 「自分の企業に紐づくものだけ」を取り出すための条件（各テーブル共通）
			const ownCompanyIds = "(SELECT id FROM companies WHERE user_id = ?)";

			const [companiesData, impressionsData, honneData, memosData, conditionsData, matchesData, recordsData, linksData] =
				await Promise.all([
					env.DB.prepare("SELECT * FROM companies WHERE user_id = ?").bind(userId).all(),
					env.DB.prepare(`SELECT * FROM impressions WHERE company_id IN ${ownCompanyIds}`).bind(userId).all(),
					env.DB.prepare(`SELECT * FROM honne WHERE company_id IN ${ownCompanyIds}`).bind(userId).all(),
					env.DB.prepare(`SELECT * FROM memos WHERE company_id IN ${ownCompanyIds}`).bind(userId).all(),
					env.DB.prepare("SELECT * FROM desired_conditions WHERE user_id = ?").bind(userId).all(),
					env.DB.prepare(`SELECT * FROM requirement_matches WHERE company_id IN ${ownCompanyIds}`).bind(userId).all(),
					env.DB.prepare(`SELECT * FROM records WHERE company_id IN ${ownCompanyIds}`).bind(userId).all(),
					env.DB.prepare(`SELECT * FROM company_links WHERE company_id IN ${ownCompanyIds}`).bind(userId).all(),
				]);

			return Response.json({
				exported_at: new Date().toISOString(),
				companies: companiesData.results,
				impressions: impressionsData.results,
				honne: honneData.results,
				memos: memosData.results,
				desired_conditions: conditionsData.results,
				requirement_matches: matchesData.results,
				records: recordsData.results,
				company_links: linksData.results,
			}, { headers: corsHeaders });
		}

		// DELETE /all-data : 自分のデータだけをすべて削除する（確認画面を経てからのみ呼び出す想定）
		// batchで順番どおりにまとめて実行する（途中で失敗した場合は、全体がなかったことになる）
		if (request.method === "DELETE" && url.pathname === "/all-data") {
			await env.DB.batch(userDataDeleteStatements(env, userId));
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// どのルートにも当てはまらなかった場合
		return Response.json({ error: "見つかりません" }, { status: 404, headers: corsHeaders });
	},

	// ---- 定期実行（Cron Trigger） ----
	// 設定ファイルの crons で決めた時刻に、Cloudflareが自動でここを呼ぶ
	// waitUntil：片づけが終わるまで、Workerを止めずに待ってもらうための指定
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(cleanupOldDemoUsers(env));
	},
};