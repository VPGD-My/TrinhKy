// ═══════════════════════════════════════════════════════════════════════
//  Sổ trình ký v6 – Edge Function admin-users
//  Chỉ Trợ lý TGĐ (đang đăng nhập, chưa bị khóa) gọi được.
//  action: create | update | reset_password | lock | unlock
//  Dùng khóa service_role (biến môi trường có sẵn của Supabase), KHÔNG để trong index.html.
//  Deploy: Dashboard › Edge Functions › Deploy a new function › tên "admin-users" › dán code › Deploy
//          hoặc: supabase functions deploy admin-users
// ═══════════════════════════════════════════════════════════════════════
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BAN_FOREVER = "876000h"; // ~100 năm

// v6.1: gửi tên đăng nhập + mật khẩu tạm qua Teams.
// Hàm gửi 1 email (Resend) tới hộp thư NOTIFY_MAILBOX, tiêu đề [TRINHKY-TAIKHOAN];
// flow Power Automate "SoTrinhKy_TaiKhoan" đọc email, nhắn Teams cho người dùng rồi xóa email.
// Dùng chung secret RESEND_API_KEY, NOTIFY_MAILBOX với hàm backup. Thêm secret:
//   NOTIFY_FROM  = địa chỉ gửi đang dùng ở hàm backup / notify-teams (đã xác minh trên Resend)
//   STK_APP_URL  = link trang Sổ trình ký (mặc định GitHub Pages bên dưới)
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const NOTIFY_MAILBOX = Deno.env.get("NOTIFY_MAILBOX");
const NOTIFY_FROM = Deno.env.get("NOTIFY_FROM");
const APP_URL = Deno.env.get("STK_APP_URL") || "https://vpgd-my.github.io/TrinhKy/";

// Trả về null nếu gửi được, hoặc thông báo lỗi
async function guiTeams(to: string, ho_ten: string, ten_dang_nhap: string, mat_khau: string, loai: "tao_moi" | "cap_lai") {
  if (!RESEND_API_KEY || !NOTIFY_MAILBOX || !NOTIFY_FROM) return "Chưa cấu hình secret RESEND_API_KEY / NOTIFY_MAILBOX / NOTIFY_FROM";
  const payload = { to, ho_ten, ten_dang_nhap, mat_khau, loai, link: APP_URL };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: [NOTIFY_MAILBOX],
        subject: `[TRINHKY-TAIKHOAN] ${ten_dang_nhap}`,
        // mỗi trường một dòng: email dạng chữ bị ngắt dòng ở khoảng ~76 ký tự, JSON 1 dòng dài
        // sẽ bị chèn xuống dòng vào giữa giá trị (VD họ tên "Phương\nPhương")
        text: JSON.stringify(payload, null, 2),
      }),
    });
    if (!r.ok) return "Gửi Teams lỗi: " + (await r.text()).slice(0, 200);
    return null;
  } catch (e) {
    return "Gửi Teams lỗi: " + (e as Error).message;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (msg: string, status = 400) => json({ ok: false, error: msg }, status);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("Chỉ nhận POST", 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 1. Xác định người gọi ────────────────────────────────────────────
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return fail("Chưa đăng nhập", 401);
  const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
  if (whoErr || !who?.user) return fail("Phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại", 401);

  const { data: me } = await admin
    .from("nguoi_dung")
    .select("id, ho_ten, vai_tro, quyen_tai_khoan, deleted_at, lanh_dao:lanh_dao_id (la_tgd, ten_ngan)")
    .eq("id", who.user.id)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const meLd = (me as any)?.lanh_dao;
  // v6.9: Trợ lý TGĐ toàn quyền. Trợ lý được bật "quyen_tai_khoan" (db/007) chỉ làm việc với tài khoản Người trình ký:
  //   tạo, sửa họ tên, cấp lại mật khẩu / nhắn Teams. Không khóa, không đổi vai trò, không cấp quyền này.
  const isTgd = !!me && me.vai_tro === "tro_ly" && !!meLd?.la_tgd;
  const isMgr = isTgd || (!!me && me.vai_tro === "tro_ly" && !!me.quyen_tai_khoan);
  if (!me || me.deleted_at || !isMgr) {
    return fail("Bạn không có quyền quản lý tài khoản. Liên hệ Trợ lý TGĐ.", 403);
  }
  const actor = `${me.ho_ten} (Trợ lý ${meLd.ten_ngan})`;

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return fail("Dữ liệu gửi lên không đúng"); }
  const action = String(body?.action || "");
  const now = new Date().toISOString();

  // deno-lint-ignore no-explicit-any
  const log = async (entityId: string, label: string, act: string, changes: any[] = [], note: string | null = null, entity = "nguoi_dung") => {
    const { error } = await admin.from("audit_log").insert([{
      user_id: me.id, user_name: actor, authenticated: true, action: act, entity,
      entity_id: entityId, entity_label: label, changes, source: "Quản lý tài khoản", note,
    }]);
    if (error) console.warn("audit_log:", error.message);
  };
  // Đăng xuất người dùng khỏi mọi máy. Lỗi không chặn thao tác chính (RLS vẫn chặn tài khoản bị khóa).
  const revoke = async (uid: string) => {
    const { error } = await admin.rpc("stk_thu_hoi_phien", { p_user: uid });
    return error ? "Không đăng xuất được trên các máy khác: " + error.message : null;
  };
  const checkRole = async (vai_tro: string, lanh_dao_id: number | null) => {
    if (vai_tro !== "nguoi_trinh" && vai_tro !== "tro_ly") return "Vai trò không hợp lệ";
    if (vai_tro === "tro_ly") {
      if (!lanh_dao_id) return "Trợ lý phải chọn lãnh đạo";
      const { data } = await admin.from("lanh_dao").select("id").eq("id", lanh_dao_id).is("deleted_at", null).maybeSingle();
      if (!data) return "Không tìm thấy lãnh đạo";
    }
    return null;
  };
  const checkPw = (pw: unknown) => typeof pw === "string" && pw.length >= 6 ? null : "Mật khẩu tối thiểu 6 ký tự";
  // Thêm nhân viên vào bảng employees nếu email chưa có (so không phân biệt hoa thường).
  // Trả về "da_co" | "da_them" | thông báo lỗi.
  const themNhanVien = async (email: string, ho_ten: string, phong_ban?: string) => {
    const pat = email.replace(/[\\%_]/g, (m) => "\\" + m);   // ilike: không coi _ % trong email là ký tự đại diện
    const { data: ex, error: e0 } = await admin.from("employees").select("id").ilike("email", pat).limit(1);
    if (e0) return "Không kiểm tra được danh sách nhân viên: " + e0.message;
    if (ex?.length) return "da_co";
    const row = { fullname: ho_ten, email, department: String(phong_ban || "").trim() || null };
    let { data: ins, error } = await admin.from("employees").insert([row]).select("id").single();
    if (error?.code === "23502") {
      // cột id không tự tăng: lấy id lớn nhất + 1 (thử lại nếu trùng)
      for (let i = 0; i < 3; i++) {
        const { data: mx } = await admin.from("employees").select("id").order("id", { ascending: false }).limit(1);
        const next = Number(mx?.[0]?.id ?? 0) + 1;
        ({ data: ins, error } = await admin.from("employees").insert([{ id: next, ...row }]).select("id").single());
        if (!error || error.code !== "23505") break;
      }
    }
    if (error || !ins) return "Không thêm được vào danh sách nhân viên: " + (error?.message || "");
    await log(String(ins.id), email, "them_nhan_vien", [
      { field: "fullname", label: "Họ tên", old: null, new: ho_ten },
      { field: "email", label: "Email", old: null, new: email },
      { field: "department", label: "Phòng ban", old: null, new: row.department },
    ], "Tự thêm khi tạo tài khoản", "employees");
    return "da_them";
  };

  const getUser = async (id: string) => {
    const { data } = await admin.from("nguoi_dung").select("*").eq("id", id).maybeSingle();
    return data;
  };

  // ── 2. Thao tác ──────────────────────────────────────────────────────
  if (action === "create") {
    const email = String(body.email || "").trim().toLowerCase();
    const ho_ten = String(body.ho_ten || "").trim();
    const vai_tro = String(body.vai_tro || "nguoi_trinh");
    const lanh_dao_id = vai_tro === "tro_ly" ? Number(body.lanh_dao_id) || null : null;
    if (!isTgd && vai_tro !== "nguoi_trinh") return fail("Chỉ Trợ lý TGĐ tạo được tài khoản trợ lý");
    const quyen_tai_khoan = isTgd && vai_tro === "tro_ly" && !!body.quyen_tai_khoan;
    const quyen_dong_dau = isTgd && !!body.quyen_dong_dau;   // v7.0: chỉ Trợ lý TGĐ cấp, mọi vai trò
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return fail("Email không đúng");
    if (!ho_ten) return fail("Nhập họ tên");
    const e = checkPw(body.password) || await checkRole(vai_tro, lanh_dao_id);
    if (e) return fail(e);
    const ten = email.split("@")[0];
    const { data: dup } = await admin.from("nguoi_dung").select("email, deleted_at").or(`email.eq."${email}",ten_dang_nhap.eq."${ten}"`);
    if (dup?.length) {
      const d = dup[0];
      return fail(d.deleted_at
        ? `Tài khoản ${d.email} đang bị khóa. Dùng "Mở khóa" thay vì tạo mới.`
        : `Tên đăng nhập "${ten}" đã có tài khoản (${d.email}).`);
    }

    const { data: created, error } = await admin.auth.admin.createUser({
      email, password: body.password, email_confirm: true, user_metadata: { ho_ten },
    });
    if (error || !created?.user) {
      return fail(/already|registered|exists/i.test(error?.message || "")
        ? "Email này đã có trong Supabase Auth nhưng chưa có trong danh sách người dùng. Liên hệ người quản trị Supabase."
        : "Không tạo được tài khoản: " + (error?.message || ""));
    }
    const { error: insErr } = await admin.from("nguoi_dung").insert([{
      id: created.user.id, email, ho_ten, vai_tro, lanh_dao_id, quyen_tai_khoan, quyen_dong_dau, phai_doi_mat_khau: true, created_by: actor,
    }]);
    if (insErr) {
      // hoàn tác: tài khoản Auth vừa tạo trong cùng thao tác, chưa có dữ liệu nào gắn vào
      await admin.auth.admin.deleteUser(created.user.id);
      return fail("Không lưu được người dùng: " + insErr.message);
    }
    await log(created.user.id, email, "them_nguoi_dung", [
      { field: "email", label: "Email", old: null, new: email },
      { field: "ho_ten", label: "Họ tên", old: null, new: ho_ten },
      { field: "vai_tro", label: "Vai trò", old: null, new: vai_tro },
    ]);
    const teamsErr = body.gui_teams ? await guiTeams(email, ho_ten, ten, body.password, "tao_moi") : null;
    if (body.gui_teams) await log(created.user.id, email, "gui_mat_khau_teams", [], teamsErr || "Đã gửi tên đăng nhập + mật khẩu tạm qua Teams");
    // v6.2: chưa có trong employees thì thêm, để chọn được ở ô Người gửi. Đã có thì giữ nguyên, không ghi đè.
    const nhanVien = body.them_nhan_vien ? await themNhanVien(email, ho_ten, body.phong_ban) : null;
    return json({ ok: true, id: created.user.id, ten_dang_nhap: ten, nhan_vien: nhanVien, teams: body.gui_teams ? (teamsErr ? "loi" : "da_gui") : null, teams_error: teamsErr });
  }

  const id = String(body.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail("Thiếu id người dùng");
  const u = await getUser(id);
  if (!u) return fail("Không tìm thấy người dùng", 404);
  const isSelf = id === me.id;
  // người quản lý (không phải Trợ lý TGĐ) chỉ thao tác tài khoản Người trình ký
  if (!isTgd && (action === "lock" || action === "unlock")) return fail("Chỉ Trợ lý TGĐ khóa / mở khóa tài khoản", 403);
  if (!isTgd && !isSelf && u.vai_tro !== "nguoi_trinh") return fail("Chỉ Trợ lý TGĐ thao tác được tài khoản trợ lý", 403);

  if (action === "update") {
    const ho_ten = String(body.ho_ten ?? u.ho_ten).trim();
    const vai_tro = isTgd ? String(body.vai_tro ?? u.vai_tro) : u.vai_tro;
    const lanh_dao_id = vai_tro === "tro_ly" ? (isTgd ? (Number(body.lanh_dao_id) || null) : u.lanh_dao_id) : null;
    const quyen_tai_khoan = vai_tro === "tro_ly" && (isTgd && !isSelf ? !!(body.quyen_tai_khoan ?? u.quyen_tai_khoan) : !!u.quyen_tai_khoan);
    const quyen_dong_dau = isTgd ? !!(body.quyen_dong_dau ?? u.quyen_dong_dau) : !!u.quyen_dong_dau;
    if (!ho_ten) return fail("Nhập họ tên");
    const e = await checkRole(vai_tro, lanh_dao_id);
    if (e) return fail(e);
    if (isSelf && (vai_tro !== u.vai_tro || lanh_dao_id !== u.lanh_dao_id)) {
      return fail("Không tự đổi vai trò của chính mình. Nhờ Trợ lý TGĐ khác đổi.");
    }
    const changes = [];
    if (ho_ten !== u.ho_ten) changes.push({ field: "ho_ten", label: "Họ tên", old: u.ho_ten, new: ho_ten });
    if (vai_tro !== u.vai_tro) changes.push({ field: "vai_tro", label: "Vai trò", old: u.vai_tro, new: vai_tro });
    if ((lanh_dao_id ?? null) !== (u.lanh_dao_id ?? null)) {
      changes.push({ field: "lanh_dao_id", label: "Trợ lý của", old: String(u.lanh_dao_id ?? ""), new: String(lanh_dao_id ?? "") });
    }
    if (quyen_tai_khoan !== !!u.quyen_tai_khoan) {
      changes.push({ field: "quyen_tai_khoan", label: "Quản lý tài khoản", old: String(!!u.quyen_tai_khoan), new: String(quyen_tai_khoan) });
    }
    if (quyen_dong_dau !== !!u.quyen_dong_dau) {
      changes.push({ field: "quyen_dong_dau", label: "Xử lý đóng dấu", old: String(!!u.quyen_dong_dau), new: String(quyen_dong_dau) });
    }
    if (!changes.length) return json({ ok: true, note: "Không có thay đổi" });
    const { error } = await admin.from("nguoi_dung")
      .update({ ho_ten, vai_tro, lanh_dao_id, quyen_tai_khoan, quyen_dong_dau, updated_at: now, updated_by: actor }).eq("id", id);
    if (error) return fail("Không lưu được: " + error.message);
    if (ho_ten !== u.ho_ten) await admin.auth.admin.updateUserById(id, { user_metadata: { ho_ten } });
    await log(id, u.email, "sua_nguoi_dung", changes);
    return json({ ok: true });
  }

  if (action === "reset_password") {
    const e = checkPw(body.password);
    if (e) return fail(e);
    if (u.deleted_at) return fail("Tài khoản đang bị khóa. Mở khóa trước.");
    const { error } = await admin.auth.admin.updateUserById(id, { password: body.password });
    if (error) return fail("Không đặt được mật khẩu: " + error.message);
    await admin.from("nguoi_dung").update({ phai_doi_mat_khau: true, updated_at: now, updated_by: actor }).eq("id", id);
    const warn = isSelf ? null : await revoke(id);
    const teamsErr = body.gui_teams ? await guiTeams(u.email, u.ho_ten, u.ten_dang_nhap, body.password, "cap_lai") : null;
    await log(id, u.email, "cap_lai_mat_khau", [], "Cấp lại mật khẩu tạm, bắt đổi ở lần đăng nhập sau" + (warn ? ". " + warn : "")
      + (body.gui_teams ? (teamsErr ? ". " + teamsErr : ". Đã gửi qua Teams") : ""));
    return json({ ok: true, warning: warn, teams: body.gui_teams ? (teamsErr ? "loi" : "da_gui") : null, teams_error: teamsErr });
  }

  if (action === "lock") {
    if (isSelf) return fail("Không tự khóa tài khoản của chính mình");
    if (u.deleted_at) return json({ ok: true, note: "Tài khoản đã bị khóa trước đó" });
    const reason = String(body.ly_do || "").trim();
    if (!reason) return fail("Nhập lý do khóa");
    const { error } = await admin.from("nguoi_dung")
      .update({ deleted_at: now, deleted_by: actor, delete_reason: reason }).eq("id", id);
    if (error) return fail("Không khóa được: " + error.message);
    const { error: banErr } = await admin.auth.admin.updateUserById(id, { ban_duration: BAN_FOREVER });
    const warn = await revoke(id);
    await log(id, u.email, "khoa_nguoi_dung", [], reason + (banErr ? ". Lỗi chặn đăng nhập: " + banErr.message : "") + (warn ? ". " + warn : ""));
    return json({ ok: true, warning: warn });
  }

  if (action === "unlock") {
    if (!u.deleted_at) return json({ ok: true, note: "Tài khoản đang hoạt động" });
    const { data: dupTen } = await admin.from("nguoi_dung").select("email")
      .eq("ten_dang_nhap", u.ten_dang_nhap).is("deleted_at", null).neq("id", id);
    if (dupTen?.length) return fail(`Tên đăng nhập "${u.ten_dang_nhap}" đang dùng cho ${dupTen[0].email}`);
    const { error: banErr } = await admin.auth.admin.updateUserById(id, { ban_duration: "none" });
    if (banErr) return fail("Không mở chặn đăng nhập được: " + banErr.message);
    const { error } = await admin.from("nguoi_dung")
      .update({ deleted_at: null, deleted_by: null, delete_reason: null, updated_at: now, updated_by: actor }).eq("id", id);
    if (error) return fail("Không mở khóa được: " + error.message);
    await log(id, u.email, "mo_khoa_nguoi_dung", [], `Mở khóa (lý do khóa trước: ${u.delete_reason || "—"})`);
    return json({ ok: true });
  }

  return fail("Thao tác không hợp lệ: " + action);
});
