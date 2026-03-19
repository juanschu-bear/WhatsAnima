-- Migration 014: Refine Brian Cox YouTube keywords using video topic metadata
UPDATE public.wa_owners
SET youtube_videos = $json$
[
  {
    "title": "Professor Brian Cox: Emergence - a brand new world tour for 2026",
    "url": "https://www.youtube.com/watch?v=Aw07Fye4hOs",
    "keywords": [
      "cosmic perspective",
      "future of space exploration",
      "science communication",
      "public science lecture"
    ],
    "source": "own"
  },
  {
    "title": "Horizons Tour - Ask Me Anything - Quantum Entanglement",
    "url": "https://www.youtube.com/watch?v=ecznlRG-Qkc",
    "keywords": [
      "quantum entanglement",
      "nonlocality",
      "measurement problem",
      "entanglement"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - Are things getting better or worse ? - Horizons Tour 2022",
    "url": "https://www.youtube.com/watch?v=88c2U5xF1hc",
    "keywords": [
      "astrophysics",
      "spacex",
      "rockets",
      "galaxy",
      "comets",
      "blackholes",
      "black holes",
      "things",
      "getting",
      "better"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - The last solar eclipse? Horizons Tour 2022",
    "url": "https://www.youtube.com/watch?v=3AYczNacoC8",
    "keywords": [
      "solar eclipse",
      "orbital alignment",
      "moon",
      "eclipse",
      "solar",
      "spacex",
      "rockets",
      "space travel",
      "elon musk",
      "last"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - Traveling at the speed of light - Horizons Tour 2022",
    "url": "https://www.youtube.com/watch?v=m7vysBJQuyM",
    "keywords": [
      "speed of light",
      "einstein",
      "space travel",
      "plantes",
      "moons",
      "rockets",
      "spacex",
      "elon musk",
      "traveling",
      "speed"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - Computer games and orbital mechanics ? Horizons Tour 2022",
    "url": "https://www.youtube.com/watch?v=OLKCDEXrjpM",
    "keywords": [
      "space travel",
      "space x",
      "rockets",
      "astrophysics",
      "future",
      "asteroids",
      "orbital mechanics",
      "computer",
      "games",
      "orbital"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - Space travel in 70 years time ?",
    "url": "https://www.youtube.com/watch?v=lXnB8Id3RQU",
    "keywords": [
      "space travel",
      "math",
      "engineering",
      "spacex",
      "rockets",
      "mars",
      "james web",
      "james webb",
      "james webb space telescope",
      "travel"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - How did they get the Lunar Rover to the moon?",
    "url": "https://www.youtube.com/watch?v=lFPedJos_YM",
    "keywords": [
      "lunar rover",
      "moon exploration",
      "apollo missions",
      "space travel",
      "moon",
      "apollo",
      "lunar",
      "rover"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - Best Places to Find Alien Life - Horizons Tour 2022",
    "url": "https://www.youtube.com/watch?v=3mCd057Llf8",
    "keywords": [
      "alien life",
      "habitability",
      "biosignatures",
      "gravity",
      "alien",
      "aliens",
      "space travel",
      "spacex",
      "best",
      "places"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - Moving with the Expanding Universe",
    "url": "https://www.youtube.com/watch?v=eEsmiiedYVQ",
    "keywords": [
      "galaxy",
      "blackholes",
      "particle physics",
      "particle accelerator",
      "moving",
      "expanding"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Horizons World Tour 2022",
    "url": "https://www.youtube.com/watch?v=IK9A42iHZDo",
    "keywords": [
      "space odyssey",
      "astronomy talk",
      "cosmic perspective",
      "future of space exploration",
      "public science lecture"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - On Tour Now",
    "url": "https://www.youtube.com/watch?v=TThN4hlXBEI",
    "keywords": [
      "astronomy presentation",
      "space lecture",
      "science communication",
      "audience questions"
    ],
    "source": "own"
  },
  {
    "title": "This Is Professor Brian Cox - Horizons World Tour 2022",
    "url": "https://www.youtube.com/watch?v=M_Wy61Tj5Dc",
    "keywords": [
      "space odyssey",
      "cosmology lecture",
      "astronomy storytelling",
      "science outreach"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - Einstein's Happiest Thought",
    "url": "https://www.youtube.com/watch?v=FMeKglqzajc",
    "keywords": [
      "science experiments",
      "spacex",
      "space discoveries",
      "james webb space telescope",
      "black holes",
      "black hole",
      "astronauts",
      "international space station",
      "einstein",
      "happiest"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - The Farthest Star in The Galaxy",
    "url": "https://www.youtube.com/watch?v=clAet7oDPsw",
    "keywords": [
      "galaxy",
      "stars",
      "star",
      "galaxies",
      "black holes",
      "spacex",
      "rockets",
      "mars",
      "moon",
      "planets"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - Donut Holes, Topology and Tour Riders",
    "url": "https://www.youtube.com/watch?v=14FN5DkqlMY",
    "keywords": [
      "geometry",
      "stars",
      "black holes",
      "galaxy",
      "galaxies",
      "donut",
      "holes",
      "topology",
      "riders"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - James Webb Space Telescope",
    "url": "https://www.youtube.com/watch?v=Wb_p8wNWz5o",
    "keywords": [
      "james webb telescope",
      "infrared astronomy",
      "james webb",
      "james webb space telescope",
      "quantum physics",
      "cosmos",
      "outer space",
      "science experiments",
      "science experiment",
      "james"
    ],
    "source": "own"
  },
  {
    "title": "Professor Brian Cox - Ask Me Anything - Gravity",
    "url": "https://www.youtube.com/watch?v=Z7DLcku1GqE",
    "keywords": [
      "gravity",
      "general relativity",
      "james webb",
      "rockets",
      "einstien",
      "black holes",
      "spacex",
      "outer space",
      "space discoveries",
      "quantum physics"
    ],
    "source": "own"
  },
  {
    "title": "Brian Cox & Robin's Ince's Christmas Compendium of Reason : Royal Albert Hall, Dec 14th 202.",
    "url": "https://www.youtube.com/watch?v=ZuscKWLRoO0",
    "keywords": [
      "robin",
      "ince",
      "christmas",
      "compendium",
      "reason",
      "royal",
      "albert",
      "hall",
      "14th"
    ],
    "source": "own"
  },
  {
    "title": "Join Professor Brian Cox on the North American leg of his Horizons Tour.  Pre-sale starts Oct. 4",
    "url": "https://www.youtube.com/watch?v=qyRmmigebOo",
    "keywords": [
      "join",
      "north",
      "american",
      "sale",
      "starts"
    ],
    "source": "own"
  },
  {
    "title": "Horizons BackStage : Do you have a backstage 'rider' ?",
    "url": "https://www.youtube.com/watch?v=CDa7oWrDBac",
    "keywords": [
      "event horizon",
      "black hole imaging",
      "astrophysics discussion",
      "science communication",
      "rider"
    ],
    "source": "own"
  },
  {
    "title": "Horizons BackStage : Brian asks a question about the Event Horizon of M87",
    "url": "https://www.youtube.com/watch?v=cL8l0mz3qPE",
    "keywords": [
      "asks",
      "question",
      "event",
      "horizon"
    ],
    "source": "own"
  },
  {
    "title": "Horizons BackStage : What happens when the science gets too complex?",
    "url": "https://www.youtube.com/watch?v=l96HdLVDcLQ",
    "keywords": [
      "happens",
      "gets",
      "complex",
      "astronomy"
    ],
    "source": "own"
  },
  {
    "title": "Joe Rogan Experience #2217 - Brian Cox",
    "url": "https://www.youtube.com/watch?v=Rc7OHXJtWco",
    "keywords": [
      "james webb telescope",
      "particle physics",
      "black holes",
      "dark matter",
      "dark energy",
      "origin of universe",
      "space exploration",
      "scientific skepticism",
      "standard model"
    ],
    "source": "external"
  },
  {
    "title": "Joe Rogan Experience #1233 - Brian Cox",
    "url": "https://www.youtube.com/watch?v=wieRZoJSVtw",
    "keywords": [
      "quantum mechanics",
      "multiverse",
      "fermi paradox",
      "alien life",
      "time travel",
      "black holes",
      "space time",
      "scientific method",
      "particle physics",
      "standard model"
    ],
    "source": "external"
  },
  {
    "title": "Joe Rogan Experience #610 - Brian Cox",
    "url": "https://www.youtube.com/watch?v=QZl3ohphHSE",
    "keywords": [
      "large hadron collider",
      "higgs boson",
      "particle physics",
      "standard model",
      "black holes",
      "science communication",
      "evidence based reasoning",
      "comedy theater genre",
      "experience"
    ],
    "source": "external"
  },
  {
    "title": "Physicist Brian Cox Shares Latest Progress in Understanding Black Holes",
    "url": "https://www.youtube.com/watch?v=WXWepL0Siao",
    "keywords": [
      "black holes",
      "event horizon",
      "comedian",
      "stand up",
      "funny",
      "clip",
      "favorite",
      "best of",
      "physicist"
    ],
    "source": "external"
  },
  {
    "title": "Are We The Only Intelligent Life in the Universe?? | Joe Rogan & Brian Cox",
    "url": "https://www.youtube.com/watch?v=p9GNCc_4f8A",
    "keywords": [
      "comedian",
      "stand up",
      "funny",
      "clip",
      "favorite",
      "best of",
      "only",
      "intelligent",
      "life"
    ],
    "source": "external"
  },
  {
    "title": "Physicist Brian Cox on Wormholes and Time Machines | Joe Rogan",
    "url": "https://www.youtube.com/watch?v=YJGi9EqLwCs",
    "keywords": [
      "wormholes",
      "space time geometry",
      "comedian",
      "stand up",
      "funny",
      "clip",
      "favorite",
      "best of",
      "physicist"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox on Dark Matter & Dark Energy | Joe Rogan",
    "url": "https://www.youtube.com/watch?v=NVCiuPIeYUM",
    "keywords": [
      "dark matter",
      "dark energy",
      "comedian",
      "stand up",
      "funny",
      "clip",
      "favorite",
      "best of",
      "dark"
    ],
    "source": "external"
  },
  {
    "title": "How We Know Space is Flat | Brian Cox and Joe Rogan",
    "url": "https://www.youtube.com/watch?v=ne3HV9tIITw",
    "keywords": [
      "comedian",
      "stand up",
      "funny",
      "clip",
      "favorite",
      "best of",
      "know",
      "flat"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox On The Most Terrifying Places In Our Solar System | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=cO87BJbwes4",
    "keywords": [
      "solar system",
      "planetary science",
      "chemistry",
      "biology",
      "space documentary",
      "science documentary",
      "solar system documentary",
      "space facts",
      "most",
      "terrifying"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox Finds Life in a Toxic Cave | Wonders Of The Solar System | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=A6nRg9e1tGg",
    "keywords": [
      "solar system",
      "planetary science",
      "chemistry",
      "biology",
      "wonders",
      "solar",
      "system",
      "investigating",
      "liquid",
      "mexico"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox Explores Saturn's Wobbly Moon | Solar System | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=vDTqfPJD5Hk",
    "keywords": [
      "solar system",
      "planetary science",
      "saturn",
      "planetary rings",
      "chemistry",
      "biology",
      "science documentary",
      "the planets",
      "space exploration",
      "the solar system"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox: The Next Space Frontier | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=uYdcVRkQBck",
    "keywords": [
      "chemistry",
      "biology",
      "next",
      "frontier"
    ],
    "source": "external"
  },
  {
    "title": "Nature's Most Astonishing Phenomena | Forces of Nature with Brian Cox | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=Q_Cv9uCWUDg",
    "keywords": [
      "chemistry",
      "biology",
      "nature",
      "most",
      "astonishing",
      "phenomena",
      "forces"
    ],
    "source": "external"
  },
  {
    "title": "Unlocking Gravity with Brian Cox | Horizon: What on Earth Is Wrong with Gravity? | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=wOvJpgjO8Ww",
    "keywords": [
      "gravity",
      "general relativity",
      "chemistry",
      "biology",
      "unlocking gravity",
      "gravity documentary",
      "horizon",
      "unlocking",
      "wrong"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox Investigates Titan Saturn's Largest Moon | Wonders Of The Solar System | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=5ssWYcXL4LE",
    "keywords": [
      "solar system",
      "planetary science",
      "saturn",
      "planetary rings",
      "titan moon",
      "methane lakes",
      "chemistry",
      "biology",
      "titan",
      "moon"
    ],
    "source": "external"
  },
  {
    "title": "The Astonishing Science of Gravity with Brian Cox | Horizon | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=hJt99qHTsd4",
    "keywords": [
      "gravity",
      "general relativity",
      "chemistry",
      "biology",
      "astonishing",
      "horizon"
    ],
    "source": "external"
  },
  {
    "title": "The Thin Blue Line - Wonders of the Solar System - BBC",
    "url": "https://www.youtube.com/watch?v=qwgfU228clE",
    "keywords": [
      "solar system",
      "planetary science",
      "thin blue line",
      "atmosphere",
      "hd blue",
      "thin",
      "blue",
      "line",
      "solar",
      "system"
    ],
    "source": "external"
  },
  {
    "title": "The Sun's Energy on Earth | Wonders of the Solar System | BBC Studios",
    "url": "https://www.youtube.com/watch?v=c17t_Pf8vI4",
    "keywords": [
      "solar system",
      "planetary science",
      "climate energy balance",
      "the sun",
      "solar energy",
      "energy",
      "solar",
      "system"
    ],
    "source": "external"
  },
  {
    "title": "Eight Wonders Of Our Solar System | The Planets | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=wkQuOrsgVGY",
    "keywords": [
      "solar system",
      "planetary science",
      "saturn",
      "planetary rings",
      "solar",
      "planets",
      "the sun",
      "space exploration",
      "the solar system explained",
      "solar system animation"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox Experiences Zero Gravity! | World Space Week - Wonders of the Universe | BBC Studios",
    "url": "https://www.youtube.com/watch?v=PosRfeUoPHM",
    "keywords": [
      "solar system",
      "planetary science",
      "microgravity",
      "human spaceflight",
      "gravity",
      "general relativity",
      "time",
      "stars",
      "planets",
      "galaxies"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox Reaches the Edge of Earth's Atmosphere | Wonders Of The Solar System | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=Iu9iD4sPiic",
    "keywords": [
      "solar system",
      "planetary science",
      "edge of atmosphere",
      "high altitude flight",
      "chemistry",
      "biology",
      "atmosphere",
      "lightning",
      "flight",
      "rocket"
    ],
    "source": "external"
  },
  {
    "title": "The Mysteries Behind Our Solar System's Majestic Planets | The Planets | BBC Earth Science",
    "url": "https://www.youtube.com/watch?v=uBJeOvWqNkg",
    "keywords": [
      "solar system",
      "planetary science",
      "saturn",
      "planetary rings",
      "chemistry",
      "biology",
      "mysteries",
      "behind",
      "solar",
      "system"
    ],
    "source": "external"
  },
  {
    "title": "Death of the Universe | Wonders of the Universe w/ Brian Cox | BBC Studios",
    "url": "https://www.youtube.com/watch?v=Untoik6c_gs",
    "keywords": [
      "entropy",
      "heat death",
      "end of universe",
      "thermodynamics",
      "stellar evolution",
      "black dwarf stars",
      "cosmic timescales",
      "solar system",
      "planetary science",
      "stars"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox explains why time travels in one direction - BBC",
    "url": "https://www.youtube.com/watch?v=uQSoaiubuA0",
    "keywords": [
      "time",
      "arrow of time",
      "entropy",
      "past future",
      "second law of thermodynamics",
      "irreversibility",
      "probability",
      "heat death",
      "namib desert",
      "sandcastle"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox visits the world's biggest vacuum | Human Universe - BBC",
    "url": "https://www.youtube.com/watch?v=E43-CfukEgs",
    "keywords": [
      "ultra high vacuum",
      "particle experiments",
      "human universe",
      "nasa",
      "vacuum",
      "bowling ball",
      "vacuum chamber",
      "feather",
      "ep 4",
      "preview"
    ],
    "source": "external"
  },
  {
    "title": "How did life begin on Earth? Professor Brian Cox explains everything! ☀️🌱  BBC",
    "url": "https://www.youtube.com/watch?v=G0GyMvq_Fjg",
    "keywords": [
      "united kingdom",
      "british tv",
      "british tv shows",
      "nature",
      "planets",
      "astronomy",
      "astrophysics",
      "life",
      "begin",
      "explains"
    ],
    "source": "external"
  },
  {
    "title": "Why we need the explorers | Brian Cox",
    "url": "https://www.youtube.com/watch?v=HdwOlk6HIVc",
    "keywords": [
      "cern",
      "large hadron collider",
      "particle collisions",
      "tedtalks",
      "talks",
      "explorers",
      "budget",
      "public funding",
      "solar system",
      "life"
    ],
    "source": "external"
  },
  {
    "title": "CERN's supercollider | Brian Cox",
    "url": "https://www.youtube.com/watch?v=_6uKZWnJLCM",
    "keywords": [
      "cern",
      "large hadron collider",
      "particle collisions",
      "tedtalks",
      "technology",
      "education",
      "supercollider"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox: Why black holes could hold the secret to time and space | Full Interview",
    "url": "https://www.youtube.com/watch?v=KZX_c6zfJ2w",
    "keywords": [
      "alien life",
      "habitability",
      "biosignatures",
      "black holes",
      "event horizon",
      "solar system",
      "planetary science",
      "gravity",
      "general relativity",
      "particle physics"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox: The quantum roots of reality | Full Interview",
    "url": "https://www.youtube.com/watch?v=kO41iURud9c",
    "keywords": [
      "black holes",
      "event horizon",
      "solar system",
      "planetary science",
      "particle physics",
      "standard model",
      "education",
      "educational videos",
      "videos",
      "faster smarter"
    ],
    "source": "external"
  },
  {
    "title": "Physicist Brian Cox explains quantum physics in 22 minutes",
    "url": "https://www.youtube.com/watch?v=BHEhxPuMmQI",
    "keywords": [
      "quantum entanglement",
      "nonlocality",
      "measurement problem",
      "alien life",
      "habitability",
      "biosignatures",
      "black holes",
      "event horizon",
      "solar system",
      "planetary science"
    ],
    "source": "external"
  },
  {
    "title": "Why haven’t we found aliens? A physicist shares the most popular theories. | Brian Cox",
    "url": "https://www.youtube.com/watch?v=dTjgrG2UY30",
    "keywords": [
      "alien life",
      "habitability",
      "biosignatures",
      "black holes",
      "event horizon",
      "solar system",
      "planetary science",
      "particle physics",
      "standard model",
      "great filter"
    ],
    "source": "external"
  },
  {
    "title": "Brian Cox on quantum computing and black hole physics",
    "url": "https://www.youtube.com/watch?v=laGXRs9Ce70",
    "keywords": [
      "black holes",
      "event horizon",
      "solar system",
      "planetary science",
      "particle physics",
      "standard model",
      "quantum computing",
      "qubits",
      "education",
      "educational videos"
    ],
    "source": "external"
  },
  {
    "title": "Are We The Universe’s Way of Knowing Itself? With Brian Cox",
    "url": "https://www.youtube.com/watch?v=tpWaAESy6RE",
    "keywords": [
      "black holes",
      "event horizon",
      "wormholes",
      "space time geometry",
      "dark matter",
      "dark energy",
      "gravity",
      "general relativity",
      "particle physics",
      "standard model"
    ],
    "source": "external"
  },
  {
    "title": "Discussing the Frontier of Particle Physics with Brian Cox",
    "url": "https://www.youtube.com/watch?v=urFIHf5coxE",
    "keywords": [
      "alien life",
      "habitability",
      "biosignatures",
      "black holes",
      "event horizon",
      "dark matter",
      "io volcanism",
      "tidal heating",
      "gravity",
      "general relativity"
    ],
    "source": "external"
  },
  {
    "title": "Multiverses & Wormholes with Brian Cox & Neil deGrasse Tyson – Cosmic Queries",
    "url": "https://www.youtube.com/watch?v=YFOeXZUlrKY",
    "keywords": [
      "quantum entanglement",
      "nonlocality",
      "measurement problem",
      "wormholes",
      "space time geometry",
      "gravity",
      "general relativity",
      "multiverse",
      "cosmological models",
      "star talk"
    ],
    "source": "external"
  },
  {
    "title": "Do Aliens Exist? Professor Brian Cox Answers Your Questions | Honesty Box",
    "url": "https://www.youtube.com/watch?v=0L3Vj56ftWM",
    "keywords": [
      "alien life",
      "habitability",
      "biosignatures",
      "black holes",
      "event horizon",
      "dark matter",
      "multiverse",
      "cosmological models",
      "sportbible",
      "tyla"
    ],
    "source": "external"
  },
  {
    "title": "Are There Infinite Universes? Brian Cox Explains | LADbible Stories",
    "url": "https://www.youtube.com/watch?v=YHRdbtDMRMg",
    "keywords": [
      "black holes",
      "event horizon",
      "wormholes",
      "space time geometry",
      "solar system",
      "planetary science",
      "documentary",
      "honesty box",
      "neil degrasse tyson",
      "david attenborough"
    ],
    "source": "external"
  }
]$json$::jsonb
WHERE id = '1d4651eb-5ff1-43e3-a0f3-76528fa32b3e';
