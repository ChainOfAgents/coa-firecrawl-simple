import { Request, Response } from "express";
import { parseMarkdown } from "../../lib/html-to-markdown";
import { z } from "zod";

const convertHtmlSchema = z.object({
  html: z.string(),
  options: z
    .object({
      useGoParser: z.boolean().optional().default(true),
    })
    .optional()
    .default({}),
});

export async function htmlToMarkdownController(req: Request, res: Response) {
  try {
    const { html, options } = convertHtmlSchema.parse(req.body);

    // Set the environment variable based on the options
    if (options.useGoParser !== undefined) {
      process.env.USE_GO_MARKDOWN_PARSER = options.useGoParser.toString();
    }

    const markdown = await parseMarkdown(html);

    return res.json({
      success: true,
      markdown,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Bad Request",
        details: error.errors,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to convert HTML to Markdown",
    });
  }
}
