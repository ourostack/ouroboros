export interface MailPalsPrompt {
  text: string
  category: string
}

export const PROMPT_POOL: MailPalsPrompt[] = [
  { text: "What's something you changed your mind about recently?", category: "reflection" },
  { text: "What's one way in which you're completely different from yourself 10 years ago?", category: "reflection" },
  { text: "What fact about yourself took you the longest to understand or accept?", category: "reflection" },
  { text: "What's something you used to be ashamed of but have come to embrace?", category: "reflection" },
  { text: "What lesson have you had to learn again and again?", category: "reflection" },
  { text: "What's something people often incorrectly assume about you?", category: "reflection" },
  { text: "When do you feel most like yourself?", category: "reflection" },
  { text: "What activity absorbs you completely and makes you lose track of time?", category: "reflection" },
  { text: "How has your definition of happiness changed as you've gotten older?", category: "reflection" },
  { text: "What's something you're coming to realize?", category: "reflection" },
  { text: "What do you take for granted?", category: "reflection" },
  { text: "What would you title your memoir?", category: "reflection" },
  { text: "What's the most important life lesson you've learned in the last 10 years?", category: "reflection" },
  { text: "What kind of person do you want to be?", category: "reflection" },
  { text: "If you had to get a tail, what tail would you want and what would you use it for?", category: "fun" },
  { text: "If you could choose one superpower, but it had to be extremely specific and unusual, what would it be?", category: "fun" },
  { text: "Without saying what the category is, what are your top five?", category: "fun" },
  { text: "If you were reincarnated as an animal based on your personality, what animal do you think you would come back as?", category: "fun" },
  { text: "What's the weirdest food combination you actually enjoy?", category: "fun" },
  { text: "If you could create a new holiday, what would it celebrate?", category: "fun" },
  { text: "What's a great name for a pet but a terrible name for a human?", category: "fun" },
  { text: "If all animals were the same size, what would win in a fight?", category: "fun" },
  { text: "A stranger is inhabiting your body for the day. What are some tips you'd give them?", category: "fun" },
  { text: "What fictional character do you most relate to?", category: "fun" },
  { text: "What's something you're embarrassed to admit you enjoy?", category: "fun" },
  { text: "If seasons never changed, which would you most like to live in eternally?", category: "fun" },
  { text: "What is the most trivial thing about which you have a strong opinion?", category: "fun" },
  { text: "Explain your job to a 3 year old.", category: "fun" },
  { text: "If you could go back and relive one day in your life without changing anything about it, which day would you choose?", category: "memory" },
  { text: "What's your favorite memory in your childhood home?", category: "memory" },
  { text: "What was the best birthday gift you ever got?", category: "memory" },
  { text: "What's something from your childhood that you think no one else could relate to?", category: "memory" },
  { text: "What embarrassing memory will forever be seared in your memory?", category: "memory" },
  { text: "What's your earliest memory?", category: "memory" },
  { text: "What is the most memorable meal you've ever had? What made it so memorable?", category: "memory" },
  { text: "What movie traumatized you as a kid?", category: "memory" },
  { text: "What was the scariest moment of your life thus far?", category: "memory" },
  { text: "What's your favorite memory with your family?", category: "memory" },
  { text: "What kind of games did you play as a child?", category: "memory" },
  { text: "What's one thing you miss the most about being a kid?", category: "memory" },
  { text: "What was your most memorable moment with your parent(s)?", category: "memory" },
  { text: "What is the dumbest but most innocent thing you believed as a child?", category: "memory" },
  { text: "If you could have any author write your life story, who would you choose?", category: "creative" },
  { text: "You get to invent something. What is it and what does it do?", category: "creative" },
  { text: "If your life was a genre of music, what would it be?", category: "creative" },
  { text: "Imagine you could bring drawings to life; what's the first thing you would draw?", category: "creative" },
  { text: "If you had to give a TED Talk without any preparation, what topic would you choose?", category: "creative" },
  { text: "You have to start a business. What would you name it, and what would it do?", category: "creative" },
  { text: "If you could telepathically say something that all 8+ billion people on Earth could hear at once, what would it be?", category: "creative" },
  { text: "What does your dream home look like?", category: "creative" },
  { text: "If you had to choose a theme song for your life, what would it be?", category: "creative" },
  { text: "If your life was a story, what chapter would you currently be in, and what would its title be?", category: "creative" },
  { text: "Share a photo of something that made you smile this week.", category: "photo" },
  { text: "Show us a photo from your camera roll that tells a story.", category: "photo" },
  { text: "Share a photo of your current view right now.", category: "photo" },
  { text: "Post a photo of something you made or cooked recently.", category: "photo" },
  { text: "Share the oldest photo on your phone. What's the context?", category: "photo" },
  { text: "Show us a photo of your favorite spot in your home.", category: "photo" },
  { text: "Share a photo that captures what your weekend looked like.", category: "photo" },
  { text: "Post a throwback photo and tell us the story behind it.", category: "photo" },
  { text: "What's something you admire about each person in this group?", category: "connection" },
  { text: "Who in your life always makes you laugh?", category: "connection" },
  { text: "How do you show someone you care about them?", category: "connection" },
  { text: "What's the most important quality you look for in a friend?", category: "connection" },
  { text: "What's something you wish you knew earlier about being a good friend?", category: "connection" },
  { text: "Which relationships have become more meaningful to you lately?", category: "connection" },
  { text: "What community do you currently feel the most connected to?", category: "connection" },
  { text: "What's the most important lesson a friend has taught you?", category: "connection" },
  { text: "If you accomplished something major, who is the first person you'd tell?", category: "connection" },
  { text: "What behavior or trait immediately makes you like someone?", category: "connection" },
  { text: "What does love mean to you?", category: "connection" },
  { text: "What's the best relationship advice you've ever received?", category: "connection" },
  { text: "What song is 10/10 in your book, but no one has heard of it?", category: "recommendation" },
  { text: "What's something expensive you splurge on that you believe is worth the money?", category: "recommendation" },
  { text: "What is the last book you read? Would you recommend it?", category: "recommendation" },
  { text: "What's a movie you can watch over and over without ever getting tired of?", category: "recommendation" },
  { text: "What's your favorite way to unwind after a busy week?", category: "recommendation" },
  { text: "What's a hobby you've always wanted to try?", category: "recommendation" },
  { text: "What's your go-to productivity hack?", category: "recommendation" },
  { text: "What's a restaurant or meal you'd recommend to everyone?", category: "recommendation" },
  { text: "What podcast or show have you been obsessed with lately?", category: "recommendation" },
  { text: "What's the best trip you've ever taken? Where should we all go?", category: "recommendation" },
  { text: "What is the smallest thing for which you are grateful?", category: "gratitude" },
  { text: "Who has had the most positive impact on your life?", category: "gratitude" },
  { text: "What's something that will make you smile every time?", category: "gratitude" },
  { text: "What do you feel like you're really good at?", category: "gratitude" },
  { text: "What's the best compliment you've ever received?", category: "gratitude" },
  { text: "What's one good thing that happened to you this week?", category: "gratitude" },
  { text: "What part of your daily routine do you genuinely enjoy?", category: "gratitude" },
  { text: "Who is someone that believed in you when you needed it most?", category: "gratitude" },
  { text: "What's a small luxury that makes your day better?", category: "gratitude" },
  { text: "What are 3 things you love about your life right now?", category: "gratitude" },
  { text: "What's a goal or project you've made progress on lately?", category: "challenge" },
  { text: "What area in your life are you looking to improve?", category: "challenge" },
  { text: "What's something you never thought you'd be able to do, until you actually did it?", category: "challenge" },
  { text: "What was the last fear you overcame and how?", category: "challenge" },
  { text: "What's the most significant risk you've ever taken, and how did it turn out?", category: "challenge" },
  { text: "What bad habits would you like to get rid of?", category: "challenge" },
  { text: "What are your biggest goals between now and the end of the year?", category: "challenge" },
  { text: "What's something you've been putting off that you could tackle this week?", category: "challenge" },
  { text: "What new skill are you working on or want to pick up?", category: "challenge" },
  { text: "What's a challenge you overcame that made you a stronger person?", category: "challenge" },
]

export function selectPrompts(count: number, seed?: number): string[] {
  const pool = [...PROMPT_POOL]
  const rng = seed !== undefined ? seededRandom(seed) : Math.random.bind(Math)
  const selected: string[] = []
  const n = Math.min(count, pool.length)
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * pool.length)
    selected.push(pool[idx].text)
    pool.splice(idx, 1)
  }
  return selected
}

function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}
