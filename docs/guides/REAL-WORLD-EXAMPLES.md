# ADCP Real-World Use Cases and Examples

## Overview

This guide provides complete, production-ready examples of common ADCP use cases using the new async execution model. Each example demonstrates practical implementations with proper error handling, monitoring, and best practices.

## Table of Contents

1. [Campaign Planning Workflow](#campaign-planning-workflow)
2. [Multi-Network Price Comparison](#multi-network-price-comparison)
3. [Automated Media Buying Pipeline](#automated-media-buying-pipeline)
4. [Human-in-the-Loop Approval System](#human-in-the-loop-approval-system)
5. [Real-time Campaign Optimization](#real-time-campaign-optimization)
6. [Audience Insights and Targeting](#audience-insights-and-targeting)
7. [Creative Asset Management](#creative-asset-management)
8. [Performance Monitoring Dashboard](#performance-monitoring-dashboard)

---

## Campaign Planning Workflow

### Scenario
A marketing team needs to plan a holiday campaign across multiple ad networks with budget approval workflows and audience validation.

```typescript
import { 
  ADCPMultiAgentClient,
  createFieldHandler,
  createConditionalHandler,
  type TaskResult
} from '@adcp/client';

interface CampaignPlan {
  name: string;
  brief: string;
  totalBudget: number;
  networks: string[];
  timeline: { start: string; end: string };
}

interface ApprovalWorkflow {
  approver: string;
  approvalLimit: number;
  autoApprove: boolean;
}

class CampaignPlanningService {
  constructor(
    private client: ADCPMultiAgentClient,
    private approvalWorkflow: ApprovalWorkflow
  ) {}

  async planCampaign(campaign: CampaignPlan): Promise<{
    products: any[];
    formats: any[];
    targeting: any[];
    estimatedReach: any[];
    requiresApproval: boolean;
    approvalToken?: string;
  }> {
    console.log(`🚀 Planning campaign: ${campaign.name}`);
    
    // Create intelligent handler based on campaign requirements
    const planningHandler = this.createPlanningHandler(campaign);
    
    try {
      // Step 1: Discover products across networks
      const productDiscovery = await this.discoverProducts(campaign, planningHandler);
      
      // Step 2: Get creative formats
      const formatDiscovery = await this.getCreativeFormats(campaign, planningHandler);
      
      // Step 3: Analyze targeting options
      const targetingAnalysis = await this.analyzeTargeting(campaign, planningHandler);
      
      // Step 4: Estimate reach and frequency
      const reachEstimation = await this.estimateReach(campaign, planningHandler);
      
      // Compile results
      return {
        products: productDiscovery.allProducts,
        formats: formatDiscovery.allFormats,
        targeting: targetingAnalysis.recommendations,
        estimatedReach: reachEstimation.estimates,
        requiresApproval: productDiscovery.requiresApproval || formatDiscovery.requiresApproval,
        approvalToken: productDiscovery.approvalToken || formatDiscovery.approvalToken
      };
      
    } catch (error) {
      console.error('Campaign planning failed:', error.message);
      throw new Error(`Campaign planning failed: ${error.message}`);
    }
  }

  private createPlanningHandler(campaign: CampaignPlan) {
    return createConditionalHandler([
      {
        // Budget allocation per network
        condition: (ctx) => ctx.inputRequest.field === 'budget',
        handler: (ctx) => {
          const budgetPerNetwork = Math.floor(campaign.totalBudget / campaign.networks.length);
          
          // Adjust based on agent reputation
          if (ctx.agent.name.includes('Premium')) {
            return Math.floor(budgetPerNetwork * 1.2);
          }
          
          return budgetPerNetwork;
        }
      },
      {
        // Targeting based on campaign brief
        condition: (ctx) => ctx.inputRequest.field === 'targeting',
        handler: (ctx) => {
          // Extract targeting from brief using keyword analysis
          const brief = campaign.brief.toLowerCase();
          
          let targeting = ['US']; // Default
          
          if (brief.includes('global') || brief.includes('international')) {
            targeting = ['US', 'CA', 'UK', 'AU', 'DE'];
          } else if (brief.includes('north america')) {
            targeting = ['US', 'CA'];
          } else if (brief.includes('europe')) {
            targeting = ['UK', 'DE', 'FR', 'IT'];
          }
          
          // Use suggestions if they overlap with our targeting
          if (ctx.inputRequest.suggestions?.length > 0) {
            const overlap = ctx.inputRequest.suggestions.filter(s => targeting.includes(s));
            if (overlap.length > 0) return overlap;
          }
          
          return targeting;
        }
      },
      {
        // Timeline-based decisions
        condition: (ctx) => ctx.inputRequest.field === 'schedule',
        handler: (ctx) => ({
          start_date: campaign.timeline.start,
          end_date: campaign.timeline.end,
          timezone: 'America/New_York'
        })
      },
      {
        // Approval workflow
        condition: (ctx) => ctx.inputRequest.field === 'approval',
        handler: (ctx) => {
          const budget = ctx.getPreviousResponse('budget') || 0;
          
          if (budget <= this.approvalWorkflow.approvalLimit && this.approvalWorkflow.autoApprove) {
            return true;
          }
          
          // Defer for human approval
          return { 
            defer: true, 
            token: `campaign-approval-${Date.now()}-${this.approvalWorkflow.approver}` 
          };
        }
      }
    ]);
  }

  private async discoverProducts(campaign: CampaignPlan, handler: any) {
    console.log('📋 Discovering products across networks...');
    
    const results = await this.client.agents(campaign.networks).getProducts({
      brief: campaign.brief,
      promoted_offering: this.extractOffering(campaign.brief)
    }, handler);
    
    const successful = results.filter(r => r.success);
    const deferred = results.filter(r => r.status === 'deferred');
    const submitted = results.filter(r => r.status === 'submitted');
    
    // Collect all products
    const allProducts = successful.flatMap(r => 
      r.data?.products?.map(p => ({
        ...p,
        network: r.metadata.agent.name,
        agentId: r.metadata.agent.id
      })) || []
    );
    
    // Handle long-running discovery
    if (submitted.length > 0) {
      console.log(`⏳ ${submitted.length} networks submitted for long-running discovery`);
      // Could implement webhook handling here
    }
    
    return {
      allProducts,
      requiresApproval: deferred.length > 0,
      approvalToken: deferred[0]?.deferred?.token,
      pendingNetworks: submitted.length
    };
  }

  private async getCreativeFormats(campaign: CampaignPlan, handler: any) {
    console.log('🎨 Analyzing creative format requirements...');
    
    const results = await this.client.agents(campaign.networks).listCreativeFormats({
      type: this.inferCreativeType(campaign.brief),
      placement: 'newsfeed'
    }, handler);
    
    const successful = results.filter(r => r.success);
    const deferred = results.filter(r => r.status === 'deferred');
    
    const allFormats = successful.flatMap(r => 
      r.data?.formats?.map(f => ({
        ...f,
        network: r.metadata.agent.name
      })) || []
    );
    
    return {
      allFormats,
      requiresApproval: deferred.length > 0,
      approvalToken: deferred[0]?.deferred?.token
    };
  }

  private async analyzeTargeting(campaign: CampaignPlan, handler: any) {
    console.log('🎯 Analyzing targeting recommendations...');
    
    // Use signals endpoint for audience insights
    const results = await this.client.agents(campaign.networks).getSignals({
      audience_type: 'lookalike',
      seed_data: this.extractAudienceSeeds(campaign.brief)
    }, handler);
    
    const successful = results.filter(r => r.success);
    
    const recommendations = successful.map(r => ({
      network: r.metadata.agent.name,
      targeting: r.data?.targeting_options || [],
      audience_size: r.data?.estimated_reach || 0,
      confidence: r.data?.confidence_score || 0
    }));
    
    return { recommendations };
  }

  private async estimateReach(campaign: CampaignPlan, handler: any) {
    console.log('📊 Estimating reach and frequency...');
    
    // This would typically call a reach estimation endpoint
    // For this example, we'll simulate the data
    
    const estimates = campaign.networks.map(networkId => ({
      network: networkId,
      estimated_reach: Math.floor(Math.random() * 1000000) + 500000,
      estimated_frequency: Math.random() * 5 + 1,
      cpm_range: {
        min: Math.random() * 5 + 2,
        max: Math.random() * 10 + 8
      }
    }));
    
    return { estimates };
  }

  private extractOffering(brief: string): string {
    // Simple keyword extraction - in practice, you'd use NLP
    if (brief.includes('product launch')) return 'New product introduction';
    if (brief.includes('holiday') || brief.includes('seasonal')) return 'Seasonal promotion';
    if (brief.includes('discount') || brief.includes('sale')) return 'Special offer';
    return 'Brand awareness';
  }

  private inferCreativeType(brief: string): string {
    if (brief.includes('video') || brief.includes('story')) return 'video';
    if (brief.includes('carousel') || brief.includes('gallery')) return 'carousel';
    return 'image';
  }

  private extractAudienceSeeds(brief: string): any[] {
    // Extract audience indicators from brief
    const seeds = [];
    
    if (brief.includes('millennials')) seeds.push({ age_range: '25-40' });
    if (brief.includes('gen z')) seeds.push({ age_range: '18-25' });
    if (brief.includes('parents')) seeds.push({ interests: ['parenting', 'family'] });
    if (brief.includes('tech')) seeds.push({ interests: ['technology', 'gadgets'] });
    
    return seeds.length > 0 ? seeds : [{ interests: ['general'] }];
  }
}

// Usage Example
async function main() {
  const client = ADCPMultiAgentClient.fromConfig();
  
  const approvalWorkflow = {
    approver: 'marketing-director',
    approvalLimit: 50000,
    autoApprove: true
  };
  
  const planningService = new CampaignPlanningService(client, approvalWorkflow);
  
  const campaign = {
    name: 'Holiday Electronics Campaign 2024',
    brief: 'Promote latest tech gadgets to millennials and tech enthusiasts during holiday season. Focus on premium products with video creative.',
    totalBudget: 150000,
    networks: ['premium-network', 'social-network', 'video-network'],
    timeline: {
      start: '2024-11-15',
      end: '2024-12-25'
    }
  };
  
  try {
    const plan = await planningService.planCampaign(campaign);
    
    console.log('\n🎉 Campaign Plan Complete!');
    console.log(`Products found: ${plan.products.length}`);
    console.log(`Formats available: ${plan.formats.length}`);
    console.log(`Networks analyzed: ${plan.targeting.length}`);
    
    if (plan.requiresApproval) {
      console.log(`⚠️  Requires approval (token: ${plan.approvalToken})`);
      // Implement approval workflow UI
    }
    
  } catch (error) {
    console.error('Campaign planning failed:', error.message);
  }
}
```

---

## Multi-Network Price Comparison

### Scenario
E-commerce company wants to find the best advertising rates across multiple networks for different product categories.

```typescript
interface PriceComparisonRequest {
  productCategories: string[];
  targetBudget: number;
  geoTargeting: string[];
  timeframe: string;
}

interface PriceAnalysis {
  network: string;
  products: Array<{
    name: string;
    category: string;
    cpm: number;
    cpc: number;
    estimatedReach: number;
    competitionLevel: 'low' | 'medium' | 'high';
  }>;
  averageCPM: number;
  totalReach: number;
  recommendationScore: number;
}

class PriceComparisonService {
  constructor(private client: ADCPMultiAgentClient) {}

  async compareNetworkPricing(request: PriceComparisonRequest): Promise<{
    analyses: PriceAnalysis[];
    bestValue: PriceAnalysis;
    recommendations: string[];
  }> {
    console.log('💰 Starting multi-network price comparison...');
    
    const comparisonHandler = createFieldHandler({
      budget: request.targetBudget,
      targeting: request.geoTargeting,
      timeframe: request.timeframe,
      categories: request.productCategories,
      pricing_model: 'cpm', // Request CPM-based pricing
      include_competition_data: true
    });

    // Query all networks in parallel
    const results = await this.client.allAgents().getProducts({
      brief: `Price comparison for ${request.productCategories.join(', ')} products`,
      targeting: request.geoTargeting,
      budget_range: {
        min: request.targetBudget * 0.8,
        max: request.targetBudget * 1.2
      }
    }, comparisonHandler);

    // Handle different response types
    const analyses: PriceAnalysis[] = [];
    const pendingAnalyses: Array<{ agentId: string; continuation: any }> = [];

    for (const result of results) {
      if (result.success && result.status === 'completed') {
        const analysis = this.analyzeNetworkPricing(result);
        analyses.push(analysis);
      } else if (result.status === 'submitted' && result.submitted) {
        pendingAnalyses.push({
          agentId: result.metadata.agent.id,
          continuation: result.submitted
        });
      }
    }

    // Wait for submitted analyses (with timeout)
    if (pendingAnalyses.length > 0) {
      console.log(`⏳ Waiting for ${pendingAnalyses.length} detailed analyses...`);
      
      const pendingResults = await Promise.allSettled(
        pendingAnalyses.map(async ({ agentId, continuation }) => {
          try {
            // Wait up to 5 minutes for price analysis
            const result = await Promise.race([
              continuation.waitForCompletion(30000), // Poll every 30s
              this.timeout(300000) // 5 minute timeout
            ]);
            
            return this.analyzeNetworkPricing(result);
          } catch (error) {
            console.warn(`Analysis timeout for agent ${agentId}`);
            return null;
          }
        })
      );

      pendingResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          analyses.push(result.value);
        }
      });
    }

    // Find best value
    const bestValue = this.findBestValue(analyses);
    const recommendations = this.generateRecommendations(analyses, request);

    return { analyses, bestValue, recommendations };
  }

  private analyzeNetworkPricing(result: TaskResult): PriceAnalysis {
    const products = result.data?.products || [];
    
    const analysisProducts = products.map(p => ({
      name: p.name,
      category: p.category || 'general',
      cpm: p.pricing?.cpm || 0,
      cpc: p.pricing?.cpc || 0,
      estimatedReach: p.reach?.estimated || 0,
      competitionLevel: this.assessCompetition(p.competition_score || 0.5)
    }));

    const averageCPM = analysisProducts.length > 0 
      ? analysisProducts.reduce((sum, p) => sum + p.cpm, 0) / analysisProducts.length
      : 0;

    const totalReach = analysisProducts.reduce((sum, p) => sum + p.estimatedReach, 0);

    const recommendationScore = this.calculateRecommendationScore({
      averageCPM,
      totalReach,
      productCount: analysisProducts.length,
      competitionLevels: analysisProducts.map(p => p.competitionLevel)
    });

    return {
      network: result.metadata.agent.name,
      products: analysisProducts,
      averageCPM,
      totalReach,
      recommendationScore
    };
  }

  private assessCompetition(score: number): 'low' | 'medium' | 'high' {
    if (score < 0.3) return 'low';
    if (score < 0.7) return 'medium';
    return 'high';
  }

  private calculateRecommendationScore(data: {
    averageCPM: number;
    totalReach: number;
    productCount: number;
    competitionLevels: string[];
  }): number {
    let score = 0;
    
    // Lower CPM is better (inverse scoring)
    score += Math.max(0, 100 - data.averageCPM * 2);
    
    // Higher reach is better
    score += Math.min(50, data.totalReach / 10000);
    
    // More products is better
    score += Math.min(25, data.productCount * 5);
    
    // Lower competition is better
    const lowCompetition = data.competitionLevels.filter(l => l === 'low').length;
    score += lowCompetition * 5;
    
    return Math.round(score);
  }

  private findBestValue(analyses: PriceAnalysis[]): PriceAnalysis {
    return analyses.reduce((best, current) => 
      current.recommendationScore > best.recommendationScore ? current : best
    );
  }

  private generateRecommendations(analyses: PriceAnalysis[], request: PriceComparisonRequest): string[] {
    const recommendations = [];
    
    const sorted = [...analyses].sort((a, b) => b.recommendationScore - a.recommendationScore);
    
    recommendations.push(
      `Best overall value: ${sorted[0]?.network} (Score: ${sorted[0]?.recommendationScore})`
    );
    
    const lowestCPM = analyses.reduce((min, curr) => 
      curr.averageCPM < min.averageCPM ? curr : min
    );
    recommendations.push(`Lowest CPM: ${lowestCPM.network} ($${lowestCPM.averageCPM.toFixed(2)})`);
    
    const highestReach = analyses.reduce((max, curr) => 
      curr.totalReach > max.totalReach ? curr : max
    );
    recommendations.push(`Highest reach: ${highestReach.network} (${highestReach.totalReach.toLocaleString()})`);
    
    // Budget allocation recommendation
    const totalBudget = request.targetBudget;
    if (sorted.length >= 2) {
      const allocation = this.optimizeBudgetAllocation(sorted.slice(0, 3), totalBudget);
      recommendations.push('Budget allocation: ' + 
        allocation.map(a => `${a.network}: $${a.budget.toLocaleString()}`).join(', ')
      );
    }
    
    return recommendations;
  }

  private optimizeBudgetAllocation(topNetworks: PriceAnalysis[], totalBudget: number) {
    // Simple allocation based on recommendation scores
    const totalScore = topNetworks.reduce((sum, n) => sum + n.recommendationScore, 0);
    
    return topNetworks.map(network => ({
      network: network.network,
      budget: Math.round((network.recommendationScore / totalScore) * totalBudget)
    }));
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), ms)
    );
  }
}

// Usage Example
async function runPriceComparison() {
  const client = ADCPMultiAgentClient.fromConfig();
  const service = new PriceComparisonService(client);
  
  const request = {
    productCategories: ['electronics', 'smartphones', 'laptops'],
    targetBudget: 100000,
    geoTargeting: ['US', 'CA'],
    timeframe: 'Q4_2024'
  };
  
  try {
    const comparison = await service.compareNetworkPricing(request);
    
    console.log('\n📊 Price Comparison Results:');
    console.log(`Analyzed ${comparison.analyses.length} networks`);
    console.log(`\n🏆 Best Value: ${comparison.bestValue.network}`);
    console.log(`   Score: ${comparison.bestValue.recommendationScore}`);
    console.log(`   Avg CPM: $${comparison.bestValue.averageCPM.toFixed(2)}`);
    console.log(`   Total Reach: ${comparison.bestValue.totalReach.toLocaleString()}`);
    
    console.log('\n💡 Recommendations:');
    comparison.recommendations.forEach(rec => console.log(`   ${rec}`));
    
  } catch (error) {
    console.error('Price comparison failed:', error.message);
  }
}
```

---

## Automated Media Buying Pipeline

### Scenario
Performance marketing team needs an automated system that creates, monitors, and optimizes media buys based on real-time performance data.

```typescript
interface MediaBuyConfig {
  campaignName: string;
  objective: 'awareness' | 'conversion' | 'engagement';
  dailyBudget: number;
  targetCPA: number;
  products: string[];
  creativeSets: Array<{
    id: string;
    format: string;
    assets: string[];
  }>;
  optimizationRules: OptimizationRule[];
}

interface OptimizationRule {
  condition: string; // e.g., "cpa > target_cpa * 1.5"
  action: 'pause' | 'reduce_budget' | 'increase_budget' | 'change_targeting';
  value?: number;
}

class AutomatedMediaBuyingPipeline {
  private activeMediaBuys = new Map<string, any>();
  private performanceMonitor: PerformanceMonitor;
  
  constructor(
    private client: ADCPMultiAgentClient,
    private notificationService: NotificationService
  ) {
    this.performanceMonitor = new PerformanceMonitor(this.handleOptimizationTrigger.bind(this));
  }

  async createMediaBuy(config: MediaBuyConfig, targetNetworks: string[]): Promise<{
    mediaBuyId: string;
    networkDeployments: Array<{
      network: string;
      status: 'created' | 'submitted' | 'failed';
      mediaBuyId?: string;
      submissionToken?: string;
    }>;
  }> {
    console.log(`🚀 Creating automated media buy: ${config.campaignName}`);
    
    const mediaBuyId = `mb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create sophisticated handler for media buy creation
    const mediaBuyHandler = this.createMediaBuyHandler(config);
    
    // Deploy to multiple networks in parallel
    const deploymentResults = await Promise.allSettled(
      targetNetworks.map(networkId => this.deployToNetwork(networkId, config, mediaBuyHandler))
    );

    const networkDeployments = deploymentResults.map((result, index) => {
      const networkId = targetNetworks[index];
      
      if (result.status === 'fulfilled') {
        return {
          network: networkId,
          ...result.value
        };
      } else {
        return {
          network: networkId,
          status: 'failed' as const,
          error: result.reason?.message
        };
      }
    });

    // Track the media buy
    this.activeMediaBuys.set(mediaBuyId, {
      config,
      deployments: networkDeployments,
      createdAt: new Date(),
      status: 'active'
    });

    // Start performance monitoring
    await this.performanceMonitor.startMonitoring(mediaBuyId, config.optimizationRules);

    return { mediaBuyId, networkDeployments };
  }

  private async deployToNetwork(
    networkId: string, 
    config: MediaBuyConfig, 
    handler: any
  ): Promise<{
    status: 'created' | 'submitted' | 'failed';
    mediaBuyId?: string;
    submissionToken?: string;
  }> {
    try {
      const agent = this.client.agent(networkId);
      
      const result = await agent.createMediaBuy({
        name: `${config.campaignName} - ${networkId}`,
        objective: config.objective,
        budget: {
          amount: config.dailyBudget,
          currency: 'USD',
          type: 'daily'
        },
        targeting: {
          geo: ['US'], // Could be derived from config
          age_range: '18-65',
          interests: this.inferInterests(config.products)
        },
        products: config.products,
        creatives: config.creativeSets,
        optimization: {
          goal: config.objective,
          target_cpa: config.targetCPA,
          bid_strategy: 'auto'
        }
      }, handler);

      if (result.success && result.status === 'completed') {
        return {
          status: 'created',
          mediaBuyId: result.data.media_buy_id
        };
      } else if (result.status === 'submitted' && result.submitted) {
        // Long-running media buy creation
        return {
          status: 'submitted',
          submissionToken: result.submitted.taskId
        };
      } else {
        throw new Error(result.error || 'Unknown error');
      }
      
    } catch (error) {
      console.error(`Failed to deploy to ${networkId}:`, error.message);
      throw error;
    }
  }

  private createMediaBuyHandler(config: MediaBuyConfig) {
    return createConditionalHandler([
      {
        condition: (ctx) => ctx.inputRequest.field === 'budget_approval',
        handler: (ctx) => {
          // Auto-approve if within daily budget limits
          const requestedBudget = ctx.inputRequest.suggestions?.[0] || config.dailyBudget;
          
          if (requestedBudget <= config.dailyBudget * 1.1) { // 10% tolerance
            return true;
          }
          
          // Defer expensive approvals
          return { 
            defer: true, 
            token: `budget_approval_${Date.now()}` 
          };
        }
      },
      {
        condition: (ctx) => ctx.inputRequest.field === 'creative_approval',
        handler: (ctx) => {
          // Validate creative sets exist
          const requestedCreatives = ctx.inputRequest.suggestions || [];
          const availableCreatives = config.creativeSets.map(cs => cs.id);
          
          const validCreatives = requestedCreatives.filter(cid => 
            availableCreatives.includes(cid)
          );
          
          return validCreatives.length > 0 ? validCreatives : availableCreatives.slice(0, 3);
        }
      },
      {
        condition: (ctx) => ctx.inputRequest.field === 'optimization_settings',
        handler: (ctx) => ({
          target_cpa: config.targetCPA,
          bid_strategy: 'target_cpa',
          optimization_window: '7_days',
          auto_pause_threshold: config.targetCPA * 2
        })
      },
      {
        condition: (ctx) => ctx.inputRequest.field === 'compliance_approval',
        handler: async (ctx) => {
          // Run automated compliance checks
          const complianceScore = await this.runComplianceCheck(config);
          
          if (complianceScore > 0.8) {
            return true;
          }
          
          // Defer for manual review
          return {
            defer: true,
            token: `compliance_review_${Date.now()}`
          };
        }
      }
    ]);
  }

  private async handleOptimizationTrigger(
    mediaBuyId: string, 
    rule: OptimizationRule, 
    performanceData: any
  ) {
    console.log(`🔧 Optimization triggered for ${mediaBuyId}: ${rule.condition}`);
    
    const mediaBuy = this.activeMediaBuys.get(mediaBuyId);
    if (!mediaBuy) return;

    const optimizationHandler = createFieldHandler({
      adjustment_reason: `Auto-optimization: ${rule.condition}`,
      approval: true // Auto-approve optimization adjustments
    });

    for (const deployment of mediaBuy.deployments) {
      if (deployment.status !== 'created') continue;

      try {
        const agent = this.client.agent(deployment.network);
        
        switch (rule.action) {
          case 'pause':
            await agent.updateMediaBuy({
              media_buy_id: deployment.mediaBuyId,
              status: 'paused',
              reason: `Auto-paused: ${rule.condition}`
            }, optimizationHandler);
            break;
            
          case 'reduce_budget':
            const newBudget = performanceData.current_budget * (rule.value || 0.8);
            await agent.updateMediaBuy({
              media_buy_id: deployment.mediaBuyId,
              budget: { amount: newBudget, currency: 'USD' },
              reason: `Budget reduced: ${rule.condition}`
            }, optimizationHandler);
            break;
            
          case 'increase_budget':
            const increasedBudget = performanceData.current_budget * (rule.value || 1.2);
            await agent.updateMediaBuy({
              media_buy_id: deployment.mediaBuyId,
              budget: { amount: increasedBudget, currency: 'USD' },
              reason: `Budget increased: ${rule.condition}`
            }, optimizationHandler);
            break;
            
          case 'change_targeting':
            await this.optimizeTargeting(agent, deployment.mediaBuyId, performanceData);
            break;
        }
        
        await this.notificationService.sendOptimizationAlert({
          mediaBuyId,
          network: deployment.network,
          action: rule.action,
          reason: rule.condition,
          performanceData
        });
        
      } catch (error) {
        console.error(`Optimization failed for ${deployment.network}:`, error.message);
      }
    }
  }

  private async optimizeTargeting(agent: any, mediaBuyId: string, performanceData: any) {
    // Get performance data to optimize targeting
    const deliveryData = await agent.getMediaBuyDelivery({
      media_buy_id: mediaBuyId,
      metrics: ['impressions', 'clicks', 'conversions'],
      breakdown: ['age', 'gender', 'geo']
    });

    if (deliveryData.success) {
      const topPerformingSegments = this.analyzePerformanceSegments(deliveryData.data);
      
      await agent.updateMediaBuy({
        media_buy_id: mediaBuyId,
        targeting: {
          include: topPerformingSegments,
          exclude: this.getUnderperformingSegments(deliveryData.data)
        },
        reason: 'Auto-optimization: targeting refinement'
      });
    }
  }

  private inferInterests(products: string[]): string[] {
    // Simple interest inference - in practice, use ML/NLP
    const interestMap: Record<string, string[]> = {
      'smartphone': ['technology', 'mobile'],
      'laptop': ['technology', 'computing'],
      'fashion': ['style', 'shopping'],
      'travel': ['travel', 'adventure'],
      'fitness': ['health', 'wellness', 'sports']
    };

    const interests = new Set<string>();
    products.forEach(product => {
      Object.entries(interestMap).forEach(([key, values]) => {
        if (product.toLowerCase().includes(key)) {
          values.forEach(interest => interests.add(interest));
        }
      });
    });

    return interests.size > 0 ? Array.from(interests) : ['general'];
  }

  private async runComplianceCheck(config: MediaBuyConfig): Promise<number> {
    // Simulate compliance checking
    let score = 1.0;
    
    // Check for restricted keywords
    const restrictedTerms = ['guaranteed', 'miracle', 'instant'];
    const hasRestricted = restrictedTerms.some(term => 
      config.campaignName.toLowerCase().includes(term)
    );
    
    if (hasRestricted) score -= 0.3;
    
    // Check budget limits
    if (config.dailyBudget > 50000) score -= 0.1;
    
    // Check creative compliance (simplified)
    if (config.creativeSets.length === 0) score -= 0.2;
    
    return Math.max(0, score);
  }

  private analyzePerformanceSegments(deliveryData: any): any[] {
    // Analyze which segments are performing best
    return deliveryData.segments
      ?.filter((s: any) => s.conversion_rate > deliveryData.average_conversion_rate)
      .slice(0, 5) || [];
  }

  private getUnderperformingSegments(deliveryData: any): any[] {
    // Identify segments to exclude
    return deliveryData.segments
      ?.filter((s: any) => s.conversion_rate < deliveryData.average_conversion_rate * 0.5)
      .slice(0, 3) || [];
  }

  async getMediaBuyStatus(mediaBuyId: string): Promise<any> {
    const mediaBuy = this.activeMediaBuys.get(mediaBuyId);
    if (!mediaBuy) throw new Error('Media buy not found');

    const statusUpdates = await Promise.allSettled(
      mediaBuy.deployments.map(async (deployment: any) => {
        if (deployment.status !== 'created') return deployment;

        try {
          const agent = this.client.agent(deployment.network);
          const delivery = await agent.getMediaBuyDelivery({
            media_buy_id: deployment.mediaBuyId
          });

          return {
            ...deployment,
            performance: delivery.success ? delivery.data : null
          };
        } catch (error) {
          return { ...deployment, error: error.message };
        }
      })
    );

    return {
      mediaBuyId,
      config: mediaBuy.config,
      deployments: statusUpdates.map(r => r.status === 'fulfilled' ? r.value : r.reason),
      overallStatus: this.calculateOverallStatus(statusUpdates)
    };
  }

  private calculateOverallStatus(statusUpdates: any[]): string {
    const successful = statusUpdates.filter(s => s.status === 'fulfilled').length;
    const total = statusUpdates.length;
    
    if (successful === total) return 'healthy';
    if (successful > total * 0.5) return 'partial';
    return 'critical';
  }
}

// Supporting classes
class PerformanceMonitor {
  constructor(private onOptimizationTrigger: Function) {}
  
  async startMonitoring(mediaBuyId: string, rules: OptimizationRule[]) {
    // Implementation would monitor performance and trigger optimizations
    console.log(`📊 Started monitoring ${mediaBuyId} with ${rules.length} optimization rules`);
  }
}

class NotificationService {
  async sendOptimizationAlert(alert: any) {
    console.log('🔔 Optimization alert:', alert);
    // Implementation would send email, Slack, etc.
  }
}

// Usage Example
async function runAutomatedMediaBuying() {
  const client = ADCPMultiAgentClient.fromConfig();
  const notificationService = new NotificationService();
  const pipeline = new AutomatedMediaBuyingPipeline(client, notificationService);
  
  const config: MediaBuyConfig = {
    campaignName: 'Black Friday Electronics Blitz 2024',
    objective: 'conversion',
    dailyBudget: 15000,
    targetCPA: 25,
    products: ['smartphone', 'laptop', 'headphones'],
    creativeSets: [
      { id: 'creative_video_1', format: 'video', assets: ['video_1.mp4', 'thumb_1.jpg'] },
      { id: 'creative_display_1', format: 'display', assets: ['banner_1.jpg'] }
    ],
    optimizationRules: [
      { condition: 'cpa > target_cpa * 1.5', action: 'reduce_budget', value: 0.8 },
      { condition: 'cpa < target_cpa * 0.7', action: 'increase_budget', value: 1.2 },
      { condition: 'conversion_rate < 0.01', action: 'pause' },
      { condition: 'spend_rate > daily_budget * 0.8 AND hour < 12', action: 'reduce_budget', value: 0.9 }
    ]
  };
  
  const targetNetworks = ['premium-network', 'social-network', 'display-network'];
  
  try {
    const result = await pipeline.createMediaBuy(config, targetNetworks);
    
    console.log('\n🎯 Media Buy Created Successfully!');
    console.log(`Media Buy ID: ${result.mediaBuyId}`);
    console.log('Network Deployments:');
    
    result.networkDeployments.forEach(deployment => {
      console.log(`  ${deployment.network}: ${deployment.status}`);
      if (deployment.mediaBuyId) {
        console.log(`    Media Buy ID: ${deployment.mediaBuyId}`);
      }
    });
    
    // Monitor performance
    setTimeout(async () => {
      const status = await pipeline.getMediaBuyStatus(result.mediaBuyId);
      console.log('\n📊 Performance Update:', status.overallStatus);
    }, 60000); // Check after 1 minute
    
  } catch (error) {
    console.error('Automated media buying failed:', error.message);
  }
}
```

This demonstrates sophisticated real-world usage of the ADCP async execution model with proper error handling, monitoring, and automation patterns. Each example shows how the four async patterns (completed, working, submitted, input-required) work together to create robust, production-ready advertising automation systems.