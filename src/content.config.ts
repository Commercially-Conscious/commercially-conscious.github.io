import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const digests = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/digests' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      pubDate: z.coerce.date(),
      weekStart: z.coerce.date(),
      weekEnd: z.coerce.date(),
      description: z.string(),
      coverImage: image().optional(),
      entries: z.array(
        z.object({
          outlet: z.string(),
          headline: z.string(),
          summary: z.string(),
          url: z.string().url(),
          category: z.string().optional(),
        }),
      ),
    }),
});

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
    publishedDate: z.coerce.date(),
    url: z.string().url(),
    author: z.enum(['Jason Semwayo', 'Ebinizer Kevin Karengera']).optional(),
    excerpt: z.string().optional(),
  }),
});

export const collections = { digests, articles };
