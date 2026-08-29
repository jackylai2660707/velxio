import { describe, expect, it } from 'vitest';
import { exampleProjects } from '../data/examples';
import { localizeExample } from '../data/exampleLocalization';

describe('example localization', () => {
  it('provides a complete Traditional Chinese detail payload for every example', () => {
    expect(exampleProjects.length).toBeGreaterThan(0);
    for (const example of exampleProjects) {
      const localized = localizeExample(example, 'zh-TW');
      expect(localized.title.trim(), example.id).not.toBe('');
      expect(localized.description.trim(), example.id).not.toBe('');
      expect(localized.overview.trim(), example.id).not.toBe('');
      expect(localized.goals).toHaveLength(3);
      expect(localized.goals.every((goal) => goal.trim().length > 0), example.id).toBe(true);
    }
  });

  it('keeps English source copy and applies curated translations', () => {
    const fade = exampleProjects.find((example) => example.id === 'fade-led');
    expect(fade).toBeDefined();
    expect(localizeExample(fade!, 'en').title).toBe(fade!.title);
    expect(localizeExample(fade!, 'zh-TW').title).toBe('LED 漸變呼吸燈');
  });
});
