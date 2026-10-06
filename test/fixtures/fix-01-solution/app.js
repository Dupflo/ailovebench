import { subtotal, applyDiscount, withVat, formatPrice } from './cart.js';

const state = {
  items: [
    { name: 'Carnet Lumio', detail: 'A5, 160 pages', unitPrice: 1450, quantity: 1 },
    { name: 'Stylo bambou', detail: 'Encre noire', unitPrice: 390, quantity: 2 },
    { name: 'Pack de stickers', detail: '12 motifs', unitPrice: 600, quantity: 1 },
  ],
  code: null,
};

const $ = (id) => document.getElementById(id);

function lineHtml(item, i) {
  return `<li class="line">
    <div class="info"><strong>${item.name}</strong><span>${item.detail} · ${formatPrice(item.unitPrice)}</span></div>
    <div class="qty" aria-label="Quantité de ${item.name}">
      <button type="button" data-action="dec" data-index="${i}" aria-label="Enlever un ${item.name}">−</button>
      <output>${item.quantity}</output>
      <button type="button" data-action="inc" data-index="${i}" aria-label="Ajouter un ${item.name}">+</button>
    </div>
    <span class="line-total">${formatPrice(item.unitPrice * item.quantity)}</span>
    <button type="button" class="remove" data-action="remove" data-index="${i}">Retirer</button>
  </li>`;
}

function render() {
  $('lines').innerHTML = state.items.map(lineHtml).join('');
  $('empty').hidden = state.items.length > 0;
  const sub = subtotal(state.items);
  const afterDiscount = applyDiscount(sub, state.code);
  const total = withVat(afterDiscount);
  $('subtotal').textContent = formatPrice(sub);
  $('discount').textContent = afterDiscount === sub ? '—' : `− ${formatPrice(sub - afterDiscount)}`;
  $('vat').textContent = formatPrice(total - afterDiscount);
  $('total').textContent = formatPrice(total);
  $('pay').textContent = `Payer ${formatPrice(total)}`;
}

$('lines').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const i = Number(button.dataset.index);
  if (button.dataset.action === 'inc') state.items[i].quantity += 1;
  if (button.dataset.action === 'dec') state.items[i].quantity = Math.max(1, state.items[i].quantity - 1);
  if (button.dataset.action === 'remove') state.items.splice(i, 1);
  render();
});

$('promo').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('promo-code').value.trim();
  try {
    applyDiscount(0, code);
    state.code = code;
    $('promo-msg').textContent = `Code ${code} appliqué.`;
  } catch {
    $('promo-msg').textContent = 'Code promo inconnu.';
  }
  render();
});

render();
