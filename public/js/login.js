/* Login page: authenticate, store the session, route by role. */

const HOME = { admin: '/admin.html', doctor: '/doctor.html', pharmacist: '/pharmacy.html' };

// Already signed in? Go straight to the right portal.
(function redirectIfSignedIn() {
  const user = getUser();
  if (token() && user && HOME[user.role]) {
    window.location.href = HOME[user.role];
  }
})();

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const btn = document.getElementById('login-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.remove('show');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: {
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      },
    });
    saveSession(data.token, data.user);
    window.location.href = HOME[data.user.role] || '/';
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

loadSettings();
