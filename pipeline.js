import tinyfish from './tinyfish.js';
import extract from './extract.js';

/**
 * JobScout Orchestrator
 * Executes Steps A through G with real-time SSE progress reporting
 */
export async function runJobScoutPipeline(params = {}, emit = () => {}) {
  const {
    role = 'Software Engineer',
    location = 'Remote',
    skills = [],
    minSalary = 0,
    experienceLevel = 'Any',
    jobType = 'Any',
    workplaceType = 'Any',
    useAgentFallback = true,
    useDemoData = false,
    apiKey = null
  } = params;

  const options = {
    apiKey,
    useMock: useDemoData || !tinyfish.hasValidApiKey(apiKey)
  };

  const startTime = Date.now();

  try {
    // =========================================================================
    // STEP A: Query Planner (5-6 search variations for ATS & regional boards)
    // =========================================================================
    emit({
      step: 'A',
      name: 'Query Planning',
      status: 'in_progress',
      message: 'Generating targeted search matrices for Greenhouse, Lever, Ashby, and job boards...'
    });

    const plannedQueries = generateSearchQueries(role, location, jobType);

    emit({
      step: 'A',
      name: 'Query Planning',
      status: 'completed',
      message: `Synthesized ${plannedQueries.length} search variations targeting top ATS systems`,
      data: {
        queries: plannedQueries.map(q => ({ label: q.label, query: q.query }))
      }
    });

    // =========================================================================
    // STEP B: TinyFish Search Execution
    // =========================================================================
    emit({
      step: 'B',
      name: 'TinyFish Search',
      status: 'in_progress',
      message: `Executing TinyFish Search API across ${plannedQueries.length} queries...`
    });

    const searchPromises = plannedQueries.map(async (pq) => {
      try {
        const results = await tinyfish.search(pq.query, location, options);
        return results.map(r => ({ ...r, planCategory: pq.label }));
      } catch (err) {
        console.warn(`[Pipeline] Search failed for query "${pq.query}": ${err.message}`);
        return [];
      }
    });

    const searchBatches = await Promise.all(searchPromises);
    const rawSearchResults = searchBatches.flat();

    // Deduplicate candidate URLs from search
    const seenSearchUrls = new Set();
    const candidateSearchResults = [];

    for (const res of rawSearchResults) {
      const canonical = cleanUrl(res.url);
      if (canonical && !seenSearchUrls.has(canonical)) {
        seenSearchUrls.add(canonical);
        candidateSearchResults.push(res);
      }
    }

    emit({
      step: 'B',
      name: 'TinyFish Search',
      status: 'completed',
      message: `Retrieved ${candidateSearchResults.length} unique candidate postings via TinyFish Search`,
      data: {
        totalFound: candidateSearchResults.length,
        sourcesFound: [...new Set(candidateSearchResults.map(c => c.source))]
      }
    });

    // =========================================================================
    // STEP C: TinyFish Fetch Execution
    // =========================================================================
    emit({
      step: 'C',
      name: 'TinyFish Fetch',
      status: 'in_progress',
      message: `Batch fetching full document text and DOM for top ${Math.min(candidateSearchResults.length, 12)} candidates...`
    });

    const topCandidateUrls = candidateSearchResults.slice(0, 12).map(c => c.url);
    const fetchedPages = await tinyfish.fetchPages(topCandidateUrls, options);

    // Identify dynamic SPAs or low-content pages needing agent fallback
    const staticPages = [];
    const dynamicCandidateUrls = [];

    for (const page of fetchedPages) {
      if (page.isDynamicSpa || !page.content || page.content.length < 250) {
        dynamicCandidateUrls.push(page.url);
      } else {
        staticPages.push(page);
      }
    }

    emit({
      step: 'C',
      name: 'TinyFish Fetch',
      status: 'completed',
      message: `Fetched ${staticPages.length} full job specifications. Detected ${dynamicCandidateUrls.length} dynamic JS portals.`,
      data: {
        staticFetched: staticPages.length,
        dynamicSpasFound: dynamicCandidateUrls.length
      }
    });

    // =========================================================================
    // STEP D: TinyFish Agent Fallback for Interactive / JS Portals
    // =========================================================================
    const agentPages = [];
    if (useAgentFallback && dynamicCandidateUrls.length > 0) {
      emit({
        step: 'D',
        name: 'TinyFish Agent Fallback',
        status: 'in_progress',
        message: `Dispatching headless TinyFish Agent for ${dynamicCandidateUrls.length} complex JS portals...`
      });

      for (const url of dynamicCandidateUrls) {
        emit({
          step: 'D',
          name: 'TinyFish Agent Fallback',
          status: 'running_agent',
          message: `Agent navigating: ${url}`
        });

        const agentResult = await tinyfish.runAgent(
          url,
          'Extract structured job description, qualifications, compensation, and direct application target',
          (agentEvent) => {
            emit({
              step: 'D',
              agentEvent: true,
              message: agentEvent.message || JSON.stringify(agentEvent),
              url
            });
          },
          options
        );

        if (agentResult && agentResult.result) {
          agentPages.push({
            url: agentResult.url,
            markdown: agentResult.result.markdown || agentResult.result.rawContent || '',
            content: agentResult.result.markdown || '',
            status: 200,
            isDynamicSpa: false,
            extractedByAgent: true
          });
        }
      }

      emit({
        step: 'D',
        name: 'TinyFish Agent Fallback',
        status: 'completed',
        message: `TinyFish Agent automation completed. Resolved ${agentPages.length} interactive job postings.`,
        data: { resolvedCount: agentPages.length }
      });
    } else {
      emit({
        step: 'D',
        name: 'TinyFish Agent Fallback',
        status: 'skipped',
        message: 'No complex JS portals encountered; skipped Agent fallback.'
      });
    }

    // =========================================================================
    // STEP E & F: Deduplication & Schema Normalization
    // =========================================================================
    emit({
      step: 'E_F',
      name: 'Deduplication & Extraction',
      status: 'in_progress',
      message: 'Extracting structured schemas and deduplicating company roles...'
    });

    const allPagesToExtract = [...staticPages, ...agentPages];
    const extractedJobs = [];
    const seenJobSignatures = new Set();

    for (const page of allPagesToExtract) {
      const matchingSearchMeta = candidateSearchResults.find(c => cleanUrl(c.url) === cleanUrl(page.url)) || {};
      const job = await extract.extractJobData(page, matchingSearchMeta);

      if (page.extractedByAgent) {
        job.extractedByAgent = true;
      }

      // Deduplication signature: normalized company + normalized title
      const signature = `${slugify(job.company)}:::${slugify(job.title)}`;
      if (!seenJobSignatures.has(signature)) {
        seenJobSignatures.add(signature);
        extractedJobs.push(job);
      }
    }

    emit({
      step: 'E_F',
      name: 'Deduplication & Extraction',
      status: 'completed',
      message: `Parsed and validated ${extractedJobs.length} structured job records`,
      data: { parsedCount: extractedJobs.length }
    });

    // =========================================================================
    // STEP G: Match Score Ranking (0-100%) and Salary Filters
    // =========================================================================
    emit({
      step: 'G',
      name: 'Match Scoring & Ranking',
      status: 'in_progress',
      message: 'Evaluating skill overlap, experience fit, compensation, and role alignment...'
    });

    const parsedSkills = Array.isArray(skills) 
      ? skills 
      : typeof skills === 'string' 
        ? skills.split(',').map(s => s.trim()).filter(Boolean)
        : [];

    const scoredJobs = extractedJobs.map((job) => {
      const scoreBreakdown = calculateMatchScore(job, {
        role,
        location,
        skills: parsedSkills,
        experienceLevel,
        jobType,
        workplaceType
      });

      return {
        ...job,
        matchScore: scoreBreakdown.total,
        scoreBreakdown
      };
    });

    // Apply Filters (Salary, Workplace, JobType)
    let filteredJobs = scoredJobs.filter((job) => {
      // Salary filter
      if (minSalary > 0) {
        if (job.maxSalary > 0 && job.maxSalary < minSalary) return false;
        if (job.minSalary > 0 && job.minSalary < minSalary && job.maxSalary === 0) return false;
      }

      // Job type filter
      if (jobType && jobType !== 'Any') {
        if (job.jobType.toLowerCase() !== jobType.toLowerCase()) return false;
      }

      // Workplace type filter
      if (workplaceType && workplaceType !== 'Any') {
        if (job.workplaceType.toLowerCase() !== workplaceType.toLowerCase()) return false;
      }

      return true;
    });

    // Sort by Match Score descending
    filteredJobs.sort((a, b) => b.matchScore - a.matchScore);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    emit({
      step: 'G',
      name: 'Match Scoring & Ranking',
      status: 'completed',
      message: `Pipeline complete in ${duration}s. Ranked ${filteredJobs.length} opportunities.`,
      data: {
        totalRanked: filteredJobs.length,
        topScore: filteredJobs[0]?.matchScore || 0,
        durationSeconds: duration
      }
    });

    return {
      success: true,
      jobs: filteredJobs,
      stats: {
        totalSearched: candidateSearchResults.length,
        totalFetched: fetchedPages.length,
        agentFallbackUsed: agentPages.length,
        totalRanked: filteredJobs.length,
        durationSeconds: duration
      }
    };
  } catch (err) {
    console.error('[Pipeline Fatal Error]', err);
    emit({
      step: 'ERROR',
      name: 'Pipeline Failure',
      status: 'failed',
      message: `Pipeline execution failed: ${err.message}`
    });
    throw err;
  }
}

/**
 * Step A Helper: Query Planner (5-6 search variations)
 */
function generateSearchQueries(role, location, jobType) {
  const locStr = location ? `"${location}"` : '';
  const isIntern = (jobType || '').toLowerCase().includes('intern') || role.toLowerCase().includes('intern');
  const roleKeywords = isIntern ? `("${role}" OR "${role} Intern" OR "Software Engineering Intern")` : `"${role}"`;

  return [
    {
      label: 'Greenhouse ATS',
      query: `site:boards.greenhouse.io ${roleKeywords} ${locStr}`.trim()
    },
    {
      label: 'Lever ATS',
      query: `site:jobs.lever.co ${roleKeywords} ${locStr}`.trim()
    },
    {
      label: 'Ashby ATS',
      query: `site:jobs.ashbyhq.com ${roleKeywords} ${locStr}`.trim()
    },
    {
      label: 'Workday Enterprise',
      query: `site:myworkdayjobs.com ${roleKeywords} ${locStr}`.trim()
    },
    {
      label: 'Startup & Tech Networks',
      query: `(site:wellfound.com OR site:linkedin.com/jobs) ${roleKeywords} ${locStr}`.trim()
    },
    {
      label: 'Direct Student / New Grad Portals',
      query: `${roleKeywords} ("internship" OR "new grad" OR "early career" OR "fresher") ${locStr} apply`.trim()
    }
  ];
}

/**
 * Step G Helper: Detailed Match Score Calculator (0 - 100%)
 */
function calculateMatchScore(job, userCriteria) {
  const { role, location, skills = [], experienceLevel, jobType, workplaceType } = userCriteria;

  // 1. Role Title Match (Weight: 40 points)
  let titleScore = 15;
  const targetWords = role.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const jobTitleLower = job.title.toLowerCase();

  let matchedWords = 0;
  for (const w of targetWords) {
    if (jobTitleLower.includes(w)) matchedWords++;
  }
  if (targetWords.length > 0) {
    titleScore += Math.round((matchedWords / targetWords.length) * 25);
  } else {
    titleScore = 30;
  }
  titleScore = Math.min(40, titleScore);

  // 2. Candidate Skills Overlap (Weight: 35 points)
  let skillsScore = 10;
  const jobSkillsLower = (job.skills || []).map(s => s.toLowerCase());
  const userSkillsLower = skills.map(s => s.toLowerCase());

  if (userSkillsLower.length > 0) {
    let matchedSkills = 0;
    for (const us of userSkillsLower) {
      if (jobSkillsLower.some(js => js.includes(us) || us.includes(js))) {
        matchedSkills++;
      }
    }
    const overlapRatio = matchedSkills / userSkillsLower.length;
    skillsScore = Math.round(overlapRatio * 35);
  } else {
    // If user provided no skills, grant neutral score
    skillsScore = 25;
  }
  skillsScore = Math.min(35, skillsScore);

  // 3. Location & Workplace Alignment (Weight: 15 points)
  let locationScore = 10;
  const jobLocLower = job.location.toLowerCase();
  const userLocLower = (location || '').toLowerCase();

  if (jobLocLower.includes('remote') || userLocLower.includes('remote')) {
    locationScore = 15;
  } else if (userLocLower && jobLocLower.includes(userLocLower)) {
    locationScore = 15;
  } else if (workplaceType && workplaceType !== 'Any' && job.workplaceType.toLowerCase() === workplaceType.toLowerCase()) {
    locationScore = 15;
  }

  // 4. Experience & Job Type Fit (Weight: 10 points)
  let expScore = 7;
  if (jobType && jobType !== 'Any' && job.jobType.toLowerCase() === jobType.toLowerCase()) {
    expScore = 10;
  } else if (experienceLevel && experienceLevel !== 'Any') {
    if (job.experience.toLowerCase().includes(experienceLevel.toLowerCase())) {
      expScore = 10;
    }
  }

  const total = Math.min(100, Math.max(20, titleScore + skillsScore + locationScore + expScore));

  return {
    total,
    titleScore,
    skillsScore,
    locationScore,
    expScore,
    matchedSkills: (job.skills || []).filter(s => 
      userSkillsLower.some(us => us.includes(s.toLowerCase()) || s.toLowerCase().includes(us))
    )
  };
}

/**
 * Clean URL of tracking parameters
 */
function cleanUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'gh_src', 'ref', 'source'];
    trackingParams.forEach(p => parsed.searchParams.delete(p));
    return parsed.toString();
  } catch {
    return url;
  }
}

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default {
  runJobScoutPipeline
};
