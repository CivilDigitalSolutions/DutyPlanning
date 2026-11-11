import { post } from '../api.js';
import { $, html } from '../util.js';

export function renderLogin(root, { onDone }) {
  root.innerHTML = html`
    <main class="auth">
      <form class="card auth-card" novalidate>
        <img src="/icons/icon.svg" alt="" width="56" height="56" />
        <h1>Duty Planning</h1>
        <p class="muted">Sign in with your staff number or username.</p>
        <label>Username or staff number<input name="username" autocomplete="username" required autofocus /></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
        <p class="error" role="alert" hidden></p>
        <button class="btn btn-primary btn-block">Sign in</button>
        ${window.DP_DEMO
          ? html`<div class="demo-logins">
              <p class="muted">This is a demo with sample teams. Choose a role to look around:</p>
              <div class="demo-buttons">
                <button type="button" class="btn" data-demo="planner|planner1234">Planner</button>
                <button type="button" class="btn" data-demo="1001|staff1234">Staff member</button>
                <button type="button" class="btn" data-demo="admin|admin1234">Admin</button>
              </div>
              <p class="muted small">Changes you make are saved in this browser only.</p>
            </div>`
          : ''}
      </form>
    </main>`;
  const form = $('form', root);
  form.addEventListener('click', (e) => {
    const d = e.target.closest('[data-demo]')?.dataset.demo;
    if (!d) return;
    [form.username.value, form.password.value] = d.split('|');
    form.requestSubmit();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error', form);
    const btn = $('button', form);
    err.hidden = true;
    btn.disabled = true;
    try {
      await post('/auth/login', { username: form.username.value.trim(), password: form.password.value });
      onDone();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      form.password.select();
    } finally {
      btn.disabled = false;
    }
  });
}

export function renderChangePassword(root, { forced = false, onDone }) {
  root.innerHTML = html`
    <div class="auth">
      <form class="card auth-card" novalidate>
        <h1>Change password</h1>
        ${forced ? html`<p class="muted">Please choose a new password before continuing.</p>` : ''}
        <label>Current password<input name="current" type="password" autocomplete="current-password" required /></label>
        <label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" required /></label>
        <label>Confirm new password<input name="confirm" type="password" autocomplete="new-password" required /></label>
        <p class="error" role="alert" hidden></p>
        <button class="btn btn-primary btn-block">Update password</button>
        ${forced ? '' : html`<button type="button" class="btn btn-block" data-cancel>Cancel</button>`}
      </form>
    </div>`;
  const form = $('form', root);
  $('[data-cancel]', form)?.addEventListener('click', onDone);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error', form);
    err.hidden = true;
    if (form.password.value !== form.confirm.value) {
      err.textContent = 'New passwords do not match';
      err.hidden = false;
      return;
    }
    try {
      await post('/auth/password', { current: form.current.value, password: form.password.value });
      onDone();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}
