import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

// Comprehensive dictionary of high-signal tech skills
const TECH_SKILLS = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Golang', 'Go', 'Rust', 'Ruby',
  'PHP', 'Swift', 'Kotlin', 'Scala', 'React', 'Next.js', 'Vue', 'Nuxt', 'Angular', 'Svelte',
  'Node.js', 'Express', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Spring Boot', 'GraphQL',
  'REST', 'gRPC', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'DynamoDB',
  'Cassandra', 'Docker', 'Kubernetes', 'AWS', 'GCP', 'Azure', 'Terraform', 'CI/CD', 'Git',
  'Linux', 'Tailwind', 'HTML5', 'CSS3', 'Redux', 'Zustand', 'Prisma', 'Drizzle', 'Kafka',
  'RabbitMQ', 'Rabbit', 'PyTorch', 'TensorFlow', 'Scikit-learn', 'OpenAI', 'LangChain',
  'LlamaIndex', 'Vector DB', 'Pinecone', 'ChromaDB', 'HuggingFace', 'Pandas', 'NumPy',
  'WebAssembly', 'Microservices', 'System Design', 'Algorithms', 'WebSockets', 'WebRTC'
];

/**
 * Main extraction function
 * Combines rule-based heuristics with optional LLM parsing
 */
export async function extractJobData(page, fallbackMetadata = {}) {
  const text = page.markdown || page.content || fallbackMetadata.snippet || '';
  const url = page.url || fallbackMetadata.url || '';

  // Check if LLM extraction is configured and available
  const llmKey = process.env.LLM_API_KEY;
  const llmProvider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

  if (llmKey && llmKey.trim() && !llmKey.includes('optional_anthropic_key')) {
    try {
      const llmJob = await extractWithLLM(text, url, llmProvider, llmKey);
      if (llmJob && llmJob.title) {
        return normalizeJobRecord(llmJob, url, page);
      }
    } catch (err) {
      console.warn(`[Extract] LLM extraction failed (${err.message}). Using heuristic extractor.`);
    }
  }

  // Default: Robust rule-based heuristic extraction
  const heuristicJob = extractHeuristic(text, url, fallbackMetadata);
  return normalizeJobRecord(heuristicJob, url, page);
}

/**
 * Rule-based heuristic extractor
 */
function extractHeuristic(text, url, fallbackMeta) {
  const company = extractCompany(text, url, fallbackMeta);
  const title = extractTitle(text, company, fallbackMeta);
  const location = extractLocation(text, fallbackMeta);
  const jobType = extractJobType(text, title);
  const workplaceType = extractWorkplaceType(text);
  const { salary, minSalary, maxSalary, currency } = extractSalary(text);
  const skills = extractSkills(text);
  const experience = extractExperience(text, jobType);
  const description = extractSnippet(text, fallbackMeta);
  const requirements = extractRequirements(text);
  const applyUrl = url || fallbackMeta.url || '#';
  const source = fallbackMeta.source || detectSourceFromUrl(url);

  return {
    id: `job-${slugify(company)}-${slugify(title)}-${Math.random().toString(36).substr(2, 6)}`,
    title,
    company,
    location,
    jobType,
    workplaceType,
    salary,
    minSalary,
    maxSalary,
    currency,
    experience,
    skills,
    description,
    requirements,
    applyUrl,
    source,
    postedAt: new Date().toISOString()
  };
}

/**
 * Extract company name from ATS URL structure or header patterns
 */
function extractCompany(text, url, fallbackMeta) {
  if (fallbackMeta.company) return fallbackMeta.company;

  // Check known ATS patterns:
  // e.g. boards.greenhouse.io/stripe/jobs/...
  // e.g. jobs.lever.co/figma/...
  // e.g. jobs.ashbyhq.com/linear/...
  if (url) {
    try {
      const parsedUrl = new URL(url);
      const host = parsedUrl.hostname;
      const parts = parsedUrl.pathname.split('/').filter(Boolean);

      if (host.includes('greenhouse.io') && parts.length > 0) {
        return capitalize(parts[0]);
      }
      if (host.includes('lever.co') && parts.length > 0) {
        return capitalize(parts[0]);
      }
      if (host.includes('ashbyhq.com') && parts.length > 0) {
        return capitalize(parts[0]);
      }
      if (host.includes('myworkdayjobs.com')) {
        const sub = host.split('.')[0];
        return capitalize(sub.replace(/[^a-zA-Z]/g, ''));
      }
    } catch {
      // ignore URL parse errors
    }
  }

  // Look for "Company: XYZ" or "**Company**: XYZ" in markdown
  const compMatch = text.match(/\*\*(?:Company|Organization)\*\*:\s*([^\n\r]+)/i) ||
                    text.match(/(?:Company|Organization):\s*([^\n\r]+)/i);
  if (compMatch && compMatch[1]) {
    return compMatch[1].trim();
  }

  // Look for "# Software Engineer at Stripe" or "Careers at Stripe"
  const headerMatch = text.match(/(?:at|join)\s+([A-Z][a-zA-Z0-9&.\s]{2,20})\b/i);
  if (headerMatch && headerMatch[1]) {
    const candidate = headerMatch[1].trim();
    if (!['The', 'Our', 'A', 'Remote', 'Apply'].includes(candidate)) {
      return candidate;
    }
  }

  return 'Innovative Tech Org';
}

/**
 * Extract Job Title from markdown headings or title tag
 */
function extractTitle(text, company, fallbackMeta) {
  if (fallbackMeta.title && !fallbackMeta.title.includes('Careers -')) {
    return cleanTitle(fallbackMeta.title);
  }

  // Match markdown headers: # Title or ## Title
  const headerLines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('#'));

  for (const h of headerLines) {
    const cleaned = h.replace(/^#+\s*/, '').trim();
    if (
      /(engineer|developer|intern|internship|architect|lead|manager|analyst|designer|scientist|full stack|frontend|backend)/i.test(cleaned)
    ) {
      return cleanTitle(cleaned);
    }
  }

  // Fallback to title keywords search
  const titleMatch = text.match(/(?:Role|Title|Position):\s*([^\n\r]+)/i);
  if (titleMatch && titleMatch[1]) {
    return cleanTitle(titleMatch[1]);
  }

  return 'Software Engineer';
}

function cleanTitle(raw) {
  return raw
    .replace(/^#+\s*/, '')
    .replace(/\s*-\s*(Greenhouse|Lever|Ashby|LinkedIn|Careers).*$/i, '')
    .replace(/\s*\|\s*.*$/, '')
    .trim();
}

/**
 * Extract Location
 */
function extractLocation(text, fallbackMeta) {
  const locMatch = text.match(/\*\*(?:Location|Place)\*\*:\s*([^\n\r]+)/i) ||
                   text.match(/(?:Location|Workplace):\s*([^\n\r]+)/i);
  if (locMatch && locMatch[1]) {
    return locMatch[1].trim();
  }

  const commonLocations = [
    'Remote', 'New Delhi, India', 'Bengaluru, India', 'Bangalore', 'San Francisco, CA',
    'New York, NY', 'Seattle, WA', 'London, UK', 'Berlin, Germany', 'Singapore', 'India',
    'Gurugram', 'Hyderabad', 'Pune', 'Noida'
  ];

  for (const loc of commonLocations) {
    const regex = new RegExp(`\\b${loc}\\b`, 'i');
    if (regex.test(text)) {
      return loc;
    }
  }

  return 'Remote / Flexible';
}

/**
 * Extract Job Type (Internship, Full-time, etc.)
 */
function extractJobType(text, title) {
  const combined = `${title} ${text}`.toLowerCase();
  if (combined.includes('internship') || combined.includes('intern') || combined.includes('co-op') || combined.includes('student')) {
    return 'Internship';
  }
  if (combined.includes('part-time') || combined.includes('part time')) {
    return 'Part-time';
  }
  if (combined.includes('contract') || combined.includes('freelance')) {
    return 'Contract';
  }
  return 'Full-time';
}

/**
 * Extract Workplace Type (Remote, Hybrid, On-site)
 */
function extractWorkplaceType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('remote') || lower.includes('work from home') || lower.includes('anywhere')) {
    return 'Remote';
  }
  if (lower.includes('hybrid')) {
    return 'Hybrid';
  }
  return 'On-site';
}

/**
 * Extract Salary / Stipend details
 */
function extractSalary(text) {
  // Common patterns:
  // $120,000 - $160,000 / year
  // ₹40,000 - ₹80,000 / month
  // $45 - $65 / hr
  // $140k - $180k
  // 15 - 25 LPA
  const usdRange = text.match(/\$(\d{2,3}(?:,\d{3})*|\d{2,3}k?)\s*-\s*\$(\d{2,3}(?:,\d{3})*|\d{2,3}k?)(?:\s*(?:\/|\sper\s*)(?:yr|year|hr|hour|mo|month))?/i);
  if (usdRange) {
    const min = parseSalaryNumber(usdRange[1], 'USD');
    const max = parseSalaryNumber(usdRange[2], 'USD');
    const period = /hr|hour/i.test(usdRange[0]) ? '/ hr' : /mo|month/i.test(usdRange[0]) ? '/ mo' : '/ yr';
    return {
      salary: `$${usdRange[1]} - $${usdRange[2]} ${period}`.trim(),
      minSalary: min,
      maxSalary: max,
      currency: 'USD'
    };
  }

  const inrRange = text.match(/(?:₹|INR|Rs\.?)\s*(\d+(?:,\d+)*(?:\s*(?:k|LPA|lakhs?))?)\s*-\s*(?:₹|INR|Rs\.?)?\s*(\d+(?:,\d+)*(?:\s*(?:k|LPA|lakhs?))?)(?:\s*(?:\/|\sper\s*)(?:yr|year|month|mo))?/i);
  if (inrRange) {
    const min = parseSalaryNumber(inrRange[1], 'INR');
    const max = parseSalaryNumber(inrRange[2], 'INR');
    const period = /mo|month/i.test(inrRange[0]) ? '/ mo' : '/ yr';
    return {
      salary: `₹${inrRange[1]} - ₹${inrRange[2]} ${period}`.trim(),
      minSalary: min,
      maxSalary: max,
      currency: 'INR'
    };
  }

  // Hourly rate check
  const hourlyMatch = text.match(/\$(\d{2,3})\s*(?:-\s*\$(\d{2,3}))?\s*\/\s*(?:hr|hour)/i);
  if (hourlyMatch) {
    const min = parseInt(hourlyMatch[1], 10) * 2000; // annualized approx
    const max = hourlyMatch[2] ? parseInt(hourlyMatch[2], 10) * 2000 : min;
    return {
      salary: hourlyMatch[0],
      minSalary: min,
      maxSalary: max,
      currency: 'USD'
    };
  }

  // Monthly stipend check
  const stipendMatch = text.match(/(?:stipend|salary):\s*([^\n\r]+)/i);
  if (stipendMatch && stipendMatch[1]) {
    return {
      salary: stipendMatch[1].trim(),
      minSalary: 50000,
      maxSalary: 100000,
      currency: 'Competitive'
    };
  }

  return {
    salary: 'Competitive Market Rate',
    minSalary: 0,
    maxSalary: 0,
    currency: 'USD'
  };
}

function parseSalaryNumber(str, currency = 'USD') {
  if (!str) return 0;
  let clean = str.toLowerCase().replace(/,/g, '').trim();
  let multiplier = 1;

  if (clean.includes('k')) {
    multiplier = 1000;
    clean = clean.replace('k', '');
  } else if (clean.includes('lpa') || clean.includes('lakh')) {
    multiplier = 100000;
    clean = clean.replace(/lpa|lakhs?/g, '');
  }

  const num = parseFloat(clean);
  if (isNaN(num)) return 0;

  let val = num * multiplier;
  // If currency is INR LPA e.g. 15 LPA => 1500000
  return Math.round(val);
}

/**
 * Extract Skills from text using predefined dictionary
 */
function extractSkills(text) {
  const found = new Set();
  const lowerText = ` ${text.toLowerCase()} `;

  for (const skill of TECH_SKILLS) {
    // Exact word boundary matching
    const escaped = skill.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(?:[^a-zA-Z0-9#+]|^)${escaped}(?:[^a-zA-Z0-9#+]|$)`, 'i');
    if (regex.test(lowerText)) {
      found.add(skill);
    }
  }

  // If few skills detected, provide core baseline tech skills
  if (found.size === 0) {
    found.add('JavaScript');
    found.add('Web Development');
    found.add('Git');
  }

  return Array.from(found).slice(0, 10);
}

/**
 * Extract Experience level requirements
 */
function extractExperience(text, jobType) {
  if (jobType === 'Internship') {
    return 'Students / Freshers';
  }

  const expMatch = text.match(/(\d+\+?\s*(?:-\s*\d+)?)\s*(?:years?|yrs?)(?:\s*of\s*experience)?/i);
  if (expMatch && expMatch[1]) {
    return `${expMatch[1]} years`;
  }

  if (/freshers?|new grad|entry[- ]level/i.test(text)) {
    return '0-2 years (Entry Level)';
  }
  if (/senior|lead|principal|staff/i.test(text)) {
    return '5+ years (Senior)';
  }

  return '1-3 years';
}

/**
 * Extract clean summary description
 */
function extractSnippet(text, fallbackMeta) {
  if (fallbackMeta.snippet && fallbackMeta.snippet.length > 50) {
    return fallbackMeta.snippet;
  }

  // Find paragraphs of reasonable length
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 40 && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('*'));

  if (lines.length > 0) {
    return lines.slice(0, 2).join(' ').substr(0, 260) + '...';
  }

  return 'Exciting engineering role working on scalable systems, modern cloud infrastructure, and impactful products.';
}

/**
 * Extract bullet requirements
 */
function extractRequirements(text) {
  const bullets = [];
  const lines = text.split('\n');
  let inReqSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/(?:requirements|qualifications|what you'?ll bring|what we look for)/i.test(trimmed)) {
      inReqSection = true;
      continue;
    }

    if (inReqSection && (trimmed.startsWith('#') || /(?:benefits|perks|about us)/i.test(trimmed))) {
      break;
    }

    if (inReqSection && (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed))) {
      const clean = trimmed.replace(/^[-*•\d.]\s*/, '').trim();
      if (clean.length > 10) {
        bullets.push(clean);
      }
    }
  }

  if (bullets.length > 0) {
    return bullets.slice(0, 5);
  }

  return [
    'Strong programming skills in modern languages and clean code architecture.',
    'Understanding of databases, API design, and asynchronous patterns.',
    'Effective verbal and written communication in collaborative environments.',
    'Curiosity, problem-solving mindset, and passion for building quality software.'
  ];
}

/**
 * LLM-based structured extraction (Anthropic or OpenAI compatible)
 */
async function extractWithLLM(text, url, provider, apiKey) {
  const truncatedText = text.slice(0, 4000);
  const prompt = `You are a high-precision job parsing engine. Analyze this job posting text and return ONLY a valid JSON object matching this schema:
{
  "title": "string (cleaned job title)",
  "company": "string (company name)",
  "location": "string (city/country or Remote)",
  "jobType": "Internship | Full-time | Contract | Part-time",
  "workplaceType": "Remote | Hybrid | On-site",
  "salary": "string (e.g. $120,000 - $150,000 / yr)",
  "minSalary": number (annualized minimum, or 0 if unlisted),
  "maxSalary": number (annualized maximum, or 0 if unlisted),
  "currency": "USD | INR | EUR | etc",
  "experience": "string (e.g. 0-2 years)",
  "skills": ["array", "of", "top", "skills"],
  "description": "string (2-3 sentences summary)",
  "requirements": ["bullet 1", "bullet 2", "bullet 3"]
}

Job Posting Content:
${truncatedText}

Output valid JSON only.`;

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      }),
      timeout: 10000
    });

    if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);
    const data = await res.json();
    const content = data.content?.[0]?.text || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  }

  return null;
}

/**
 * Normalization helper ensuring all fields are strictly typed and safe
 */
function normalizeJobRecord(job, url, page) {
  return {
    id: job.id || `job-${Math.random().toString(36).substr(2, 9)}`,
    title: job.title || 'Software Engineer',
    company: job.company || 'Tech Pioneer',
    location: job.location || 'Remote',
    jobType: job.jobType || 'Full-time',
    workplaceType: job.workplaceType || 'Remote',
    salary: job.salary || 'Competitive',
    minSalary: typeof job.minSalary === 'number' ? job.minSalary : 0,
    maxSalary: typeof job.maxSalary === 'number' ? job.maxSalary : 0,
    currency: job.currency || 'USD',
    experience: job.experience || 'Entry / Mid',
    skills: Array.isArray(job.skills) ? job.skills : [],
    description: job.description || '',
    requirements: Array.isArray(job.requirements) ? job.requirements : [],
    applyUrl: job.applyUrl || url || '#',
    source: job.source || detectSourceFromUrl(url),
    postedAt: job.postedAt || new Date().toISOString()
  };
}

function detectSourceFromUrl(url) {
  const l = (url || '').toLowerCase();
  if (l.includes('greenhouse.io')) return 'Greenhouse';
  if (l.includes('lever.co')) return 'Lever';
  if (l.includes('ashbyhq.com')) return 'Ashby';
  if (l.includes('workday')) return 'Workday';
  if (l.includes('linkedin.com')) return 'LinkedIn';
  if (l.includes('wellfound.com')) return 'Wellfound';
  return 'Direct Career Portal';
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default {
  extractJobData
};
