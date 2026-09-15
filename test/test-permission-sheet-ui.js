import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityDeviationHtml, capabilityRowHtml } from '../public/settings/pages/admin-permissions.js';

function selectedValue(html) {
  return html.match(/<button[^>]*aria-checked="true"[^>]*data-value="([^"]+)"/)?.[1];
}

test('sparse role capability rows render each catalog default as selected', () => {
  const view = { mode: 'role', draft: {}, inherited: {} };
  const fasting = capabilityRowHtml({
    key: 'health_use_fasting', default: 'allow', labelKey: 'settings.permCapabilityFasting',
  }, { ...view, label: 'Fasting' });
  const notes = capabilityRowHtml({
    key: 'notes_manage_household_categories', default: 'none', labelKey: 'settings.permCapabilityNotes',
  }, { ...view, label: 'Notes' });

  assert.equal(selectedValue(fasting), 'allow');
  assert.equal(selectedValue(notes), 'none');
});

test('sparse role capability defaults do not render a deviation marker', () => {
  const fasting = {
    key: 'health_use_fasting', default: 'allow', labelKey: 'settings.permCapabilityFasting',
  };
  const view = { mode: 'role', draft: {}, inherited: {}, label: 'Fasting' };

  assert.equal(capabilityDeviationHtml(fasting, view), '');
  assert.match(capabilityDeviationHtml(fasting, { ...view, draft: { health_use_fasting: 'none' } }), /Fasting/);
});
